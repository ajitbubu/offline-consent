/**
 * The converged intake pipeline.
 *
 * All four intake modes - manual entry, scan review, bulk CSV and kiosk -
 * produce an intake_draft with the same payload shape, and commitDraft() below
 * is the ONLY thing in the application that writes consent_artifact. There is
 * deliberately no bypass: even the kiosk's confirmation screen goes through
 * this function, so there is exactly one place where paper becomes evidence.
 */
import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, type Executor } from "@/lib/db";
import { env } from "@/lib/env";
import { writeAudit, type ComplianceTag } from "@/lib/audit";
import {
  intakeModeForSource,
  noticeOwed,
  type IntakeSource,
  type NoticeAtCollection,
  type ValidationIssue,
} from "@/lib/consent";
import { normaliseEmail, normalisePhone } from "@/lib/phone";

/* -------------------------------------------------------------------------- */
/* Payload                                                                    */
/* -------------------------------------------------------------------------- */

export const draftPayloadSchema = z.object({
  principal: z.object({
    fullName: z.string().trim().min(2, "Enter the full name as written on the form"),
    // The raw transcription is kept alongside the normalised form so that a
    // later re-review can see what the paper actually said, rather than only
    // what we managed to parse from it.
    phone: z.string().trim().nullable().default(null),
    phoneE164: z.string().nullable().default(null),
    email: z.string().trim().toLowerCase().nullable().default(null),
  }),
  noticeId: z.string().uuid().nullable().default(null),
  noticeAtCollection: z
    .enum(["attached", "printed_on_form", "none", "unknown"])
    .default("unknown"),
  collectedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker")
    .nullable()
    .default(null),
  collectedOnPrecision: z.enum(["day", "month", "year", "unknown"]).default("unknown"),
  collectionLocation: z.string().trim().nullable().default(null),
  subjectDeclaration: z.string().trim().nullable().default(null),
  items: z
    .array(
      z.object({
        purposeId: z.string().uuid(),
        granted: z.boolean(),
        verbatimLabel: z.string().trim().min(1),
      }),
    )
    .min(1, "The form must cover at least one purpose"),
});

export type DraftPayload = z.infer<typeof draftPayloadSchema>;

/** An empty payload, used to open a blank manual-entry draft. */
export const emptyPayload = (): DraftPayload => ({
  principal: { fullName: "", phone: null, phoneE164: null, email: null },
  noticeId: null,
  noticeAtCollection: "unknown",
  collectedOn: null,
  collectedOnPrecision: "unknown",
  collectionLocation: null,
  subjectDeclaration: null,
  items: [],
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Today, as a civil date in the register's own timezone.
 *
 * 'en-CA' formats as YYYY-MM-DD, which compares correctly against the
 * 'YYYY-MM-DD' strings the DATE parser in db.ts returns.
 */
const todayInAppZone = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: env.APP_TIMEZONE }).format(new Date());

/**
 * Errors block a commit; warnings do not.
 *
 * A phone number that will not normalise is an ERROR, not a warning. Storing it
 * anyway would leave the person permanently unable to reach the withdrawal
 * portal - s.6(4) would fail for them silently, with nothing in the system to
 * show it - so the reviewer is sent back to the scan instead.
 */
export function validateDraft(
  payload: DraftPayload,
  knownPurposeIds: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const p = payload.principal;

  if (p.fullName.trim().length < 2) {
    issues.push({
      field: "fullName",
      severity: "error",
      message: "Enter the full name as written on the form",
    });
  }

  const phone = normalisePhone(p.phone);
  const email = normaliseEmail(p.email);

  if (p.phone && !phone) {
    issues.push({
      field: "phone",
      severity: "error",
      message: `"${p.phone}" is not a phone number we can dial. Check the scan.`,
    });
  }
  if (p.email && !email) {
    issues.push({ field: "email", severity: "error", message: "This is not a valid email address" });
  }
  if (!phone && !email) {
    issues.push({
      field: "phone",
      severity: "error",
      message:
        "A phone number or an email address is required, otherwise this person can never withdraw their consent.",
    });
  }

  if (payload.items.length === 0) {
    issues.push({ field: "items", severity: "error", message: "Record at least one purpose" });
  }
  const seenPurposeIds = new Set<string>();
  for (const item of payload.items) {
    if (!knownPurposeIds.has(item.purposeId)) {
      issues.push({
        field: "items",
        severity: "error",
        message: `"${item.verbatimLabel}" is not mapped to a purpose in the catalogue`,
      });
    }
    // One purpose, one answer. The artifact items are written with ON CONFLICT
    // DO NOTHING (first wins) while the projection loop below overwrites (last
    // wins), so a duplicated purpose made the immutable evidence and the
    // mutable record disagree about the same tick-box - the exact divergence
    // the artifact/record split exists to prevent. Refused rather than
    // silently resolved: which answer the paper really gave is a question for
    // the reviewer, not for a tie-break rule.
    if (seenPurposeIds.has(item.purposeId)) {
      issues.push({
        field: "items",
        severity: "error",
        message: `"${item.verbatimLabel}" appears twice. Record one answer per purpose.`,
      });
    }
    seenPurposeIds.add(item.purposeId);
  }

  if (payload.collectedOn) {
    const collected = new Date(`${payload.collectedOn}T00:00:00Z`);
    if (Number.isNaN(collected.getTime())) {
      issues.push({ field: "collectedOn", severity: "error", message: "Not a valid date" });
    } else if (payload.collectedOn > todayInAppZone()) {
      // Compared as civil dates in the register's own timezone. Comparing a
      // paper date against an instant used to reject a form dated today for
      // anyone working between midnight and 05:30 IST, because UTC was still on
      // yesterday's date.
      issues.push({
        field: "collectedOn",
        severity: "error",
        message: "The form cannot have been signed in the future",
      });
    } else if (collected.getUTCFullYear() < 2015) {
      issues.push({
        field: "collectedOn",
        severity: "warning",
        message: "This form is unusually old. Check the year on the scan.",
      });
    }
  }

  // consent_artifact_date_matches_precision (migration 005) enforces this pairing
  // at the database. Without a mirror here it was only discovered at the artifact
  // INSERT, inside the commit transaction and after identity resolution, where it
  // surfaced to the reviewer as an unexplained 500 with no field to correct.
  if ((payload.collectedOnPrecision === "unknown") !== (payload.collectedOn === null)) {
    issues.push({
      field: "collectedOn",
      severity: "error",
      message:
        payload.collectedOn === null
          ? "Enter the date on the form, or set the precision to \"Undated form\""
          : "An undated form cannot carry a date. Clear the date or change the precision.",
    });
  }

  if (payload.collectedOnPrecision === "unknown") {
    issues.push({
      field: "collectedOn",
      severity: "warning",
      message: "Undated form. An undated consent is a weak consent.",
    });
  }
  if (noticeOwed(payload.noticeAtCollection)) {
    issues.push({
      field: "noticeAtCollection",
      severity: "warning",
      message: "No notice recorded at collection. This person is owed a notice under s.5(2).",
    });
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Identity matching                                                          */
/* -------------------------------------------------------------------------- */

export interface PrincipalMatch {
  principalId: string;
  reason: "exact_contact_and_name" | "fuzzy_name";
  fullName: string;
}

/**
 * Finds the person this form belongs to. An exact match on (contact point,
 * normalised name) is the person. A close-but-not-equal name on the same
 * contact point is reported so a human can decide - it is never merged
 * automatically, because fusing two real people leaks one person's consent
 * state into the other's record.
 */
export async function matchPrincipal(
  payload: DraftPayload,
  executor: Executor = pool,
): Promise<{ exact: PrincipalMatch | null; candidates: PrincipalMatch[] }> {
  const phone = normalisePhone(payload.principal.phone);
  const email = normaliseEmail(payload.principal.email);
  if (!phone && !email) return { exact: null, candidates: [] };

  const { rows } = await executor.query<{
    id: string;
    full_name: string;
    exact: boolean;
    similarity: number;
  }>(
    `SELECT id,
            full_name,
            name_key = lower(regexp_replace(btrim($3), '\\s+', ' ', 'g')) AS exact,
            similarity(name_key, lower(regexp_replace(btrim($3), '\\s+', ' ', 'g'))) AS similarity
       FROM data_principal
      WHERE merged_into_id IS NULL
        AND (($1::text IS NOT NULL AND phone_e164 = $1)
          OR ($2::text IS NOT NULL AND email = $2))`,
    [phone, email, payload.principal.fullName],
  );

  const exactRow = rows.find((r) => r.exact);
  if (exactRow) {
    return {
      exact: {
        principalId: exactRow.id,
        reason: "exact_contact_and_name",
        fullName: exactRow.full_name,
      },
      candidates: [],
    };
  }

  // A different name on the same phone is ordinary - households and workplaces
  // share numbers. Only a name close enough to look like a transcription
  // variant is worth stopping a human for.
  const candidates = rows
    .filter((r) => r.similarity > 0.6)
    .map(
      (r): PrincipalMatch => ({
        principalId: r.id,
        reason: "fuzzy_name",
        fullName: r.full_name,
      }),
    );

  return { exact: null, candidates };
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                     */
/* -------------------------------------------------------------------------- */

export type CommitErrorCode =
  | "draft_not_found"
  | "draft_not_reviewable"
  | "validation_failed"
  | "possible_duplicate";

export class CommitError extends Error {
  constructor(
    readonly code: CommitErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "CommitError";
  }
}

/** Deterministic JSON so the same content always hashes to the same digest. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface CommitResult {
  artifactId: string;
  dataPrincipalId: string;
  recordsWritten: number;
  /** Purposes left withdrawn because the person withdrew after this form was signed. */
  withheldPurposeIds: string[];
  noticeOwed: boolean;
}

interface CommitInput {
  draftId: string;
  staffId: string;
  /** Set by the reviewer when they have confirmed which existing person this is. */
  confirmPrincipalId?: string | null;
  /**
   * Set when the reviewer has looked at the near-duplicate candidates and
   * decided none of them is this person. Only a human may make that call, so
   * this can never be inferred - it has to be sent deliberately.
   */
  forceNew?: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Turns a reviewed draft into evidence.
 *
 * Everything below happens in one transaction, so the artifact, its items, the
 * projected consent records and the audit entry either all land or none do.
 */
export async function commitDraft(
  input: CommitInput,
  client: Executor,
): Promise<CommitResult> {
  const { rows: draftRows } = await client.query<{
    id: string;
    status: string;
    source: IntakeSource;
    payload: DraftPayload;
    evidence_id: string | null;
    signature_evidence_id: string | null;
    matched_principal_id: string | null;
  }>(
    `SELECT id, status, source, payload, evidence_id, signature_evidence_id, matched_principal_id
       FROM intake_draft WHERE id = $1 FOR UPDATE`,
    [input.draftId],
  );

  const draft = draftRows[0];
  if (!draft) throw new CommitError("draft_not_found", "Draft not found");
  if (draft.status !== "needs_review") {
    throw new CommitError(
      "draft_not_reviewable",
      `This draft is already ${draft.status} and cannot be committed again`,
    );
  }

  const payload = draftPayloadSchema.parse(draft.payload);

  const { rows: purposeRows } = await client.query<{ id: string }>("SELECT id FROM purpose");
  const issues = validateDraft(payload, new Set(purposeRows.map((r) => r.id)));
  const blocking = issues.filter((i) => i.severity === "error");
  if (blocking.length > 0) {
    throw new CommitError("validation_failed", "The draft has unresolved errors", blocking);
  }

  const phone = normalisePhone(payload.principal.phone);
  const email = normaliseEmail(payload.principal.email);

  /* -- 1. Resolve the person ---------------------------------------------- */

  const chosenId = input.confirmPrincipalId ?? draft.matched_principal_id;
  let principalId: string;

  if (chosenId) {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM data_principal WHERE id = $1 FOR UPDATE",
      [chosenId],
    );
    if (rows.length === 0) throw new CommitError("draft_not_found", "Selected person no longer exists");
    principalId = rows[0].id;
  } else {
    const { exact, candidates } = await matchPrincipal(payload, client);

    if (exact) {
      principalId = exact.principalId;
    } else if (candidates.length > 0 && !input.forceNew) {
      // 2. Duplicate guard. Never merged automatically - a human decides.
      throw new CommitError(
        "possible_duplicate",
        "This may be someone already in the register",
        candidates,
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO data_principal (full_name, phone_e164, email)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [payload.principal.fullName.trim(), phone, email],
      );

      if (inserted.rows.length > 0) {
        principalId = inserted.rows[0].id;
      } else {
        // A concurrent commit created the same person between the match and the
        // insert. Re-read and use whichever transaction won.
        const retry = await matchPrincipal(payload, client);
        if (!retry.exact) {
          throw new CommitError("draft_not_found", "Could not resolve the person for this form");
        }
        principalId = retry.exact.principalId;
      }
    }
  }

  /* -- 3. The artifact ----------------------------------------------------- */

  const payloadHash = createHash("sha256")
    .update(
      canonicalJson({
        principal: { fullName: payload.principal.fullName.trim(), phone, email },
        noticeId: payload.noticeId,
        collectedOn: payload.collectedOn,
        items: [...payload.items]
          .map((i) => ({ purposeId: i.purposeId, granted: i.granted }))
          .sort((a, b) => (a.purposeId < b.purposeId ? -1 : 1)),
        evidenceId: draft.evidence_id,
        signatureEvidenceId: draft.signature_evidence_id,
      }),
    )
    .digest("hex");

  const { rows: artifactRows } = await client.query<{ id: string }>(
    `INSERT INTO consent_artifact
       (data_principal_id, notice_id, notice_at_collection, collected_on,
        collected_on_precision, collection_location, subject_declaration,
        intake_mode, intake_draft_id, evidence_id, signature_evidence_id,
        transcribed_by, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      principalId,
      payload.noticeId,
      payload.noticeAtCollection,
      payload.collectedOn,
      payload.collectedOnPrecision,
      payload.collectionLocation,
      payload.subjectDeclaration,
      intakeModeForSource[draft.source],
      draft.id,
      draft.evidence_id,
      draft.signature_evidence_id,
      input.staffId,
      payloadHash,
    ],
  );
  const artifactId = artifactRows[0].id;

  /* -- 4. The items -------------------------------------------------------- */

  for (const item of payload.items) {
    await client.query(
      `INSERT INTO consent_artifact_item (artifact_id, purpose_id, granted, verbatim_label)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (artifact_id, purpose_id) DO NOTHING`,
      [artifactId, item.purposeId, item.granted, item.verbatimLabel],
    );
  }

  /* -- 5. Project onto consent_record -------------------------------------- */

  const withheldPurposeIds: string[] = [];
  let recordsWritten = 0;

  for (const item of payload.items) {
    const { rows: existingRows } = await client.query<{
      id: string;
      status: string;
      withdrawn_on: string | null;
      consent_given_on: string | null;
      version: number;
    }>(
      // withdrawn_at is a TIMESTAMPTZ and collected_on is a date off a piece of
      // paper. Rendering the instant in UTC to compare them - which is what
      // .toISOString() did - dated every withdrawal made between 00:00 and
      // 05:30 IST a day early, and a day early is enough to make a withdrawal
      // look older than the form and be overridden by it. Cast to a civil date
      // in the register's own timezone here, so both sides of every comparison
      // below are 'YYYY-MM-DD' strings and no JS Date is involved at all.
      `SELECT id, status, consent_given_on, version,
              (withdrawn_at AT TIME ZONE $3)::date AS withdrawn_on
         FROM consent_record
        WHERE data_principal_id = $1 AND purpose_id = $2
        FOR UPDATE`,
      [principalId, item.purposeId, env.APP_TIMEZONE],
    );
    const existing = existingRows[0];

    if (!existing) {
      await client.query(
        `INSERT INTO consent_record
           (data_principal_id, purpose_id, status, source_artifact_id, consent_given_on)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          principalId,
          item.purposeId,
          item.granted ? "active" : "declined",
          artifactId,
          payload.collectedOn,
        ],
      );
      recordsWritten += 1;
      continue;
    }

    // The rules that are easy to get wrong, and they are one rule: a form only
    // wins if it can be SHOWN to be later. Everything here is a comparison
    // between two civil dates.
    //
    //   collectedOn NULL ──► never resurrects, never supersedes
    //   withdrawn_on >= collectedOn ──► withhold  (a tie cannot be ordered)
    //   consent_given_on > collectedOn ──► skip   (an older form)
    //   otherwise ──► write

    // An undated form proves no ordering against anything. Invariant 6 already
    // says so for a withdrawal; it is equally true of a dated active record,
    // which the supersession check below used to let an undated form overwrite
    // because it required BOTH dates to be non-null before it would skip.
    if (payload.collectedOn === null) {
      if (existing.status === "withdrawn") withheldPurposeIds.push(item.purposeId);
      continue;
    }

    // A form digitised today may have been signed years ago; if the person has
    // withdrawn since, committing it must not resurrect the consent they took
    // back. `>=` rather than `>`: a withdrawal and a form on the SAME day
    // cannot be ordered from day-precision data, and auth.ts:revokedBy already
    // resolves exactly this tie toward refusing, which is the right direction
    // for a register of this kind.
    if (existing.status === "withdrawn") {
      if (existing.withdrawn_on === null || existing.withdrawn_on >= payload.collectedOn) {
        withheldPurposeIds.push(item.purposeId);
        continue;
      }
    }

    // Two forms for the same purpose: the later signature wins. An existing
    // record sourced from a newer form is left alone.
    if (existing.consent_given_on !== null && existing.consent_given_on > payload.collectedOn) {
      continue;
    }

    await client.query(
      `UPDATE consent_record
          SET status = $2,
              source_artifact_id = $3,
              consent_given_on = $4,
              withdrawn_at = NULL,
              withdrawal_channel = NULL,
              withdrawal_reason = NULL,
              version = version + 1
        WHERE id = $1`,
      [existing.id, item.granted ? "active" : "declined", artifactId, payload.collectedOn],
    );
    recordsWritten += 1;
  }

  /* -- 6. Audit ------------------------------------------------------------ */

  const owed = noticeOwed(payload.noticeAtCollection as NoticeAtCollection);
  const tags: ComplianceTag[] = owed ? ["dpdp_s6_1", "dpdp_s5_2"] : ["dpdp_s6_1"];

  await writeAudit(
    {
      action: "consent_digitised",
      actorType: "staff",
      actorId: input.staffId,
      dataPrincipalId: principalId,
      artifactId,
      newState: {
        source: draft.source,
        collectedOn: payload.collectedOn,
        precision: payload.collectedOnPrecision,
        noticeAtCollection: payload.noticeAtCollection,
        granted: payload.items.filter((i) => i.granted).length,
        declined: payload.items.filter((i) => !i.granted).length,
        withheld: withheldPurposeIds.length,
        payloadHash,
      },
      complianceTags: tags,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    client,
  );

  /* -- 7. Close the draft, and make double submission impossible ------------ */

  const closed = await client.query(
    `UPDATE intake_draft
        SET status = 'committed',
            committed_artifact_id = $2,
            reviewed_by = $3,
            reviewed_at = now(),
            matched_principal_id = $4
      WHERE id = $1 AND status = 'needs_review'`,
    [draft.id, artifactId, input.staffId, principalId],
  );

  // Zero rows means another request committed this draft while we were working.
  // Throwing rolls the whole transaction back, so the second artifact never
  // exists - this UPDATE is the idempotency token for the entire operation.
  if (closed.rowCount === 0) {
    throw new CommitError("draft_not_reviewable", "This draft was committed by someone else");
  }

  return {
    artifactId,
    dataPrincipalId: principalId,
    recordsWritten,
    withheldPurposeIds,
    noticeOwed: owed,
  };
}
