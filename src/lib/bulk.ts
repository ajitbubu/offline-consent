/**
 * Bulk CSV import (FR-15).
 *
 * A CSV of already-digitised records is still paper consent - somebody typed it
 * out of a filing cabinet once already - so it goes through the same door as
 * everything else: one intake_draft per row, reviewed, then commitDraft(). There
 * is no bulk write path into consent_artifact and there is not going to be one.
 *
 * Two rules shape everything here.
 *
 * ROW INDEPENDENCE. FR-15 says each row commits in its own transaction. A
 * ten-thousand-row import that fails atomically on row 9,999 is worthless: the
 * operator has no way to tell which rows were good and no way to retry only the
 * bad ones. So a failure is a row-level fact, recorded against that row, and the
 * rest of the batch carries on.
 *
 * NEVER GUESS. A cell this code cannot read confidently becomes a blocking error
 * on that row, never an assumption. That applies to tick-boxes (an unrecognised
 * value is not "no") and to dates (03/04/2019 is 3 April in one country and 4
 * March in another, and this register exists to record which). The cost of
 * refusing is one operator fixing a column; the cost of guessing is consent
 * evidence that says something the paper did not.
 */
import "server-only";
import Papa from "papaparse";
import { z, ZodError } from "zod";
import { pool, withTransaction, type Executor } from "@/lib/db";
import { CommitError, commitDraft, draftPayloadSchema, validateDraft } from "@/lib/intake";
import { getEvidenceBytes } from "@/lib/evidence";
import type { ValidationIssue } from "@/lib/consent";

/** Field key -> CSV header. `purpose:<code>` maps a tick-box column. */
export const columnMappingSchema = z.record(z.string(), z.string().min(1));
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

export const MAPPABLE_FIELDS = [
  { key: "full_name", label: "Full name", required: true },
  { key: "phone", label: "Mobile number", required: false },
  { key: "email", label: "Email", required: false },
  { key: "collected_on", label: "Date signed (YYYY-MM-DD)", required: false },
  { key: "collection_location", label: "Where it was collected", required: false },
] as const;

// Deliberately short and explicit. Anything outside these lists is a row error,
// because a tick-box is the difference between processing someone's data and not.
const TRUE_VALUES = new Set(["y", "yes", "true", "1", "x", "✓", "checked", "agreed"]);
const FALSE_VALUES = new Set(["n", "no", "false", "0", "", "-", "unchecked", "declined"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CsvPreview {
  headers: string[];
  rowCount: number;
  sample: Record<string, string>[];
}

export function parseCsv(text: string): CsvPreview {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const rows = parsed.data.filter((r) => Object.values(r).some((v) => (v ?? "").trim() !== ""));
  return {
    headers: parsed.meta.fields?.map((f) => f.trim()) ?? [],
    rowCount: rows.length,
    sample: rows.slice(0, 5),
  };
}

export interface RowOutcome {
  rowNumber: number;
  issues: ValidationIssue[];
}

/**
 * Turns a mapped CSV into one draft per row.
 *
 * Every row becomes a draft even when it is broken, because a row that silently
 * vanishes between the spreadsheet and the review queue is worse than a row that
 * shows up with an error on it - the operator has to be able to see all ten
 * thousand accounted for.
 */
export async function buildDrafts(
  input: {
    batchId: string;
    text: string;
    mapping: ColumnMapping;
    noticeId: string | null;
    staffId: string;
    purposes: { id: string; code: string; label: string }[];
  },
  client: Executor,
): Promise<RowOutcome[]> {
  const { headers, rowCount } = parseCsv(input.text);
  const parsed = Papa.parse<Record<string, string>>(input.text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const rows = parsed.data.filter((r) => Object.values(r).some((v) => (v ?? "").trim() !== ""));
  void headers;

  const knownPurposeIds = new Set(input.purposes.map((p) => p.id));
  const outcomes: RowOutcome[] = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    const cell = (field: string): string =>
      (input.mapping[field] ? (row[input.mapping[field]] ?? "") : "").trim();

    const issues: ValidationIssue[] = [];

    const rawDate = cell("collected_on");
    let collectedOn: string | null = null;
    if (rawDate !== "") {
      if (ISO_DATE.test(rawDate)) {
        collectedOn = rawDate;
      } else {
        // 03/04/2019 is 3 April in one country and 4 March in another. This
        // register exists to record which, so it refuses rather than picks.
        issues.push({
          field: "collectedOn",
          severity: "error",
          message: `"${rawDate}" is ambiguous. Dates must be written YYYY-MM-DD.`,
        });
      }
    }

    const items: { purposeId: string; granted: boolean; verbatimLabel: string }[] = [];
    for (const purpose of input.purposes) {
      const header = input.mapping[`purpose:${purpose.code}`];
      if (!header) continue;
      const raw = (row[header] ?? "").trim().toLowerCase();
      if (TRUE_VALUES.has(raw)) {
        items.push({ purposeId: purpose.id, granted: true, verbatimLabel: purpose.label });
      } else if (FALSE_VALUES.has(raw)) {
        items.push({ purposeId: purpose.id, granted: false, verbatimLabel: purpose.label });
      } else {
        issues.push({
          field: "items",
          severity: "error",
          message: `"${raw}" in ${header} is not a yes or a no. An unreadable tick-box cannot be guessed.`,
        });
      }
    }

    const payload = {
      principal: {
        fullName: cell("full_name"),
        phone: cell("phone") || null,
        phoneE164: null,
        email: cell("email") || null,
      },
      noticeId: input.noticeId,
      noticeAtCollection: "unknown" as const,
      collectedOn,
      collectedOnPrecision: (collectedOn ? "day" : "unknown") as "day" | "unknown",
      collectionLocation: cell("collection_location") || null,
      subjectDeclaration: null,
      items,
    };

    // Parse leniently: a row that fails the schema still gets a draft, so the
    // operator sees it in the report rather than wondering where it went.
    const safe = draftPayloadSchema.safeParse(payload);
    if (safe.success) {
      issues.push(...validateDraft(safe.data, knownPurposeIds));
    } else {
      for (const problem of safe.error.issues) {
        issues.push({
          field: problem.path.join(".") || "row",
          severity: "error",
          message: problem.message,
        });
      }
    }

    await client.query(
      `INSERT INTO intake_draft
         (source, batch_id, row_number, source_row, payload, validation, created_by)
       VALUES ('bulk_csv', $1, $2, $3, $4, $5, $6)`,
      [
        input.batchId,
        rowNumber,
        JSON.stringify(row),
        JSON.stringify(safe.success ? safe.data : payload),
        JSON.stringify(issues),
        input.staffId,
      ],
    );

    outcomes.push({ rowNumber, issues });
  }

  await client.query(
    "UPDATE intake_batch SET row_count = $2, status = 'validated', column_mapping = $3, notice_id = $4 WHERE id = $1",
    [input.batchId, rowCount, JSON.stringify(input.mapping), input.noticeId],
  );

  return outcomes;
}

export interface BatchCommitResult {
  committed: number;
  /** Rows that were tried and failed - a duplicate, a race, a database error. */
  skipped: { rowNumber: number; reason: string; code: string }[];
  /**
   * Rows never attempted, because the report already said they need a person.
   * Distinct from `skipped` on purpose: "we tried and could not" and "we did not
   * try, because you have not resolved it yet" are different facts to whoever
   * reads the import report.
   */
  held: number;
}

/**
 * Commits every clean row, each in its own transaction.
 *
 * A duplicate is never resolved automatically here. commitDraft throws
 * possible_duplicate when a near-identical name shares a contact point, and in a
 * ten-thousand-row import the temptation is to pass forceNew and move on - which
 * is precisely how one person becomes two records nobody can reconcile
 * (Invariant 11). Those rows stay open in the review queue for a human, which is
 * why the DPO register and merge had to exist before this did.
 */
export async function commitBatch(
  batchId: string,
  staffId: string,
): Promise<BatchCommitResult> {
  // Only the rows the report showed as ready.
  //
  // This filter is load-bearing, not a shortcut. commitDraft recomputes
  // validation from the payload and knows nothing about the CSV the payload came
  // from, so the errors that are specific to importing - an ambiguous date, a
  // tick-box that read neither yes nor no - do not exist as far as it is
  // concerned. Without this, a row whose date said 03/04/2019 committed as an
  // UNDATED artifact, and a row whose tick-box said "maybe" committed with that
  // purpose silently absent from the evidence. Both look like clean commits and
  // both quietly record something the spreadsheet did not say, which is exactly
  // what the never-guess rule at the top of this file exists to prevent.
  const { rows: drafts } = await pool.query<{ id: string; row_number: number }>(
    `SELECT id, row_number FROM intake_draft
      WHERE batch_id = $1
        AND status = 'needs_review'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(validation) v
           WHERE v->>'severity' = 'error'
        )
      ORDER BY row_number`,
    [batchId],
  );

  const skipped: BatchCommitResult["skipped"] = [];
  let committed = 0;

  for (const draft of drafts) {
    try {
      // One transaction per row: a failure on row 9,999 must not undo the 9,998
      // rows that were fine.
      await withTransaction((client) => commitDraft({ draftId: draft.id, staffId }, client));
      committed += 1;
    } catch (error) {
      // A row can fail validation two ways: validateDraft catches most of it,
      // but a payload too broken to parse at all fails in the schema inside
      // commitDraft. Both are the same fact to the operator reading the report -
      // this row did not pass - so they get the same label rather than an
      // unhelpful "error".
      const code =
        error instanceof CommitError
          ? error.code
          : error instanceof ZodError
            ? "validation_failed"
            : "error";
      const reason =
        error instanceof ZodError
          ? error.issues.map((i) => `${i.path.join(".") || "row"}: ${i.message}`).join("; ")
          : error instanceof Error
            ? error.message
            : "Unknown error";
      skipped.push({ rowNumber: draft.row_number, reason, code });
    }
  }

  // Rows held back by the filter above never reach `skipped`, so the batch's
  // status is decided by what is still open rather than by what failed here.
  const { rows: remaining } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM intake_draft WHERE batch_id = $1 AND status = 'needs_review'",
    [batchId],
  );
  await pool.query(
    `UPDATE intake_batch
        SET status = CASE WHEN $2::int = 0 THEN 'committed' ELSE 'partially_committed' END
      WHERE id = $1`,
    [batchId, Number(remaining[0].n)],
  );

  return { committed, skipped, held: Number(remaining[0].n) - skipped.length };
}

/** Reads the uploaded CSV back out of evidence storage. */
export async function loadBatchText(storageKey: string): Promise<string> {
  const bytes = await getEvidenceBytes(storageKey);
  return bytes.toString("utf8");
}
