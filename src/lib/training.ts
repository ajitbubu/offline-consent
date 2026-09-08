/**
 * The training set for text extraction (FR-17).
 *
 * The model cannot be built yet and that is a data problem, not an engineering
 * one: layout classification needs labelled forms, and labels only exist once
 * real scans have been through a human. The PRD's answer is that the review
 * screen IS the annotation tool - every committed draft pairs OCR tokens with a
 * payload a person confirmed against the paper.
 *
 * So this is the half that can be built now: the export, and the count. The
 * count matters more than it looks. "Text extraction waits for fifty to a
 * hundred real scans" is unfalsifiable until somebody can see the number, and a
 * number nobody can see is how a dependency quietly becomes an excuse.
 *
 * WEAK SUPERVISION, stated plainly. The pair is (tokens, confirmed payload), not
 * (tokens, per-token labels) - nobody drew boxes round the name. Field labels
 * below are recovered by matching the confirmed value back against the token
 * stream, which is good enough to train on and is not ground truth. A field the
 * matcher cannot find is emitted with a null span rather than a guessed one.
 */
import "server-only";
import { pool, type Executor } from "@/lib/db";
import type { OcrTokens } from "@/lib/consent";

/** The PRD's threshold for text extraction being worth attempting at all. */
export const CORPUS_TARGET = 50;

export interface CorpusStatus {
  /** Committed drafts carrying OCR tokens - the trainable pairs. */
  pairs: number;
  /** Committed drafts with a scan but no tokens: banked before extraction ran. */
  missedPairs: number;
  target: number;
  ready: boolean;
}

/**
 * Reads the partial index that has existed since migration 008 for exactly this
 * purpose (`status = 'committed' AND ocr_tokens IS NOT NULL`) and had no caller.
 */
export async function corpusStatus(executor: Executor = pool): Promise<CorpusStatus> {
  const { rows } = await executor.query<{ pairs: string; missed: string }>(
    `SELECT count(*) FILTER (WHERE ocr_tokens IS NOT NULL)                              AS pairs,
            count(*) FILTER (WHERE ocr_tokens IS NULL AND evidence_id IS NOT NULL)      AS missed
       FROM intake_draft
      WHERE status = 'committed'`,
  );
  const pairs = Number(rows[0].pairs);
  return {
    pairs,
    missedPairs: Number(rows[0].missed),
    target: CORPUS_TARGET,
    ready: pairs >= CORPUS_TARGET,
  };
}

export interface FieldLabel {
  field: string;
  value: string;
  /** Token indices on that page, or null when the value could not be located. */
  page: number | null;
  tokenIndices: number[] | null;
  bbox: [number, number, number, number] | null;
}

export interface TrainingExample {
  draftId: string;
  artifactId: string | null;
  engine: string;
  engineVersion: string;
  pages: OcrTokens["pages"];
  labels: FieldLabel[];
}

const normalise = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s@.+-]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Finds the token run whose text matches `value`.
 *
 * Deliberately conservative: it returns a span only when the joined tokens equal
 * the normalised value, or contain it as a whole. A fuzzy match here would mint
 * labels that look like ground truth and are not, and a model trained on those
 * learns the matcher's mistakes rather than the form's layout.
 */
function locate(pages: OcrTokens["pages"], value: string): Omit<FieldLabel, "field" | "value"> {
  const target = normalise(value);
  if (target === "") return { page: null, tokenIndices: null, bbox: null };

  for (const page of pages) {
    const words = page.tokens.map((t) => normalise(t.text));
    for (let start = 0; start < words.length; start += 1) {
      let joined = "";
      for (let end = start; end < Math.min(start + 12, words.length); end += 1) {
        joined = joined === "" ? words[end] : `${joined} ${words[end]}`;
        if (joined === target || joined.replace(/\s/g, "") === target.replace(/\s/g, "")) {
          const span = page.tokens.slice(start, end + 1);
          return {
            page: page.page,
            tokenIndices: Array.from({ length: end - start + 1 }, (_, i) => start + i),
            bbox: [
              Math.min(...span.map((t) => t.bbox[0])),
              Math.min(...span.map((t) => t.bbox[1])),
              Math.max(...span.map((t) => t.bbox[2])),
              Math.max(...span.map((t) => t.bbox[3])),
            ],
          };
        }
        if (joined.length > target.length + 24) break;
      }
    }
  }
  return { page: null, tokenIndices: null, bbox: null };
}

interface Row {
  id: string;
  committed_artifact_id: string | null;
  ocr_tokens: OcrTokens;
  payload: {
    principal: { fullName: string; phone: string | null; email: string | null };
    collectedOn: string | null;
    collectionLocation: string | null;
  };
}

export async function exportTrainingSet(
  limit = 5000,
  executor: Executor = pool,
): Promise<TrainingExample[]> {
  const { rows } = await executor.query<Row>(
    `SELECT id, committed_artifact_id, ocr_tokens, payload
       FROM intake_draft
      WHERE status = 'committed' AND ocr_tokens IS NOT NULL
      ORDER BY reviewed_at
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) => {
    const pages = row.ocr_tokens.pages ?? [];
    const candidates: [string, string | null][] = [
      ["fullName", row.payload.principal.fullName],
      ["phone", row.payload.principal.phone],
      ["email", row.payload.principal.email],
      ["collectedOn", row.payload.collectedOn],
      ["collectionLocation", row.payload.collectionLocation],
    ];

    return {
      draftId: row.id,
      artifactId: row.committed_artifact_id,
      engine: row.ocr_tokens.engine,
      engineVersion: row.ocr_tokens.engineVersion,
      pages,
      labels: candidates
        .filter(([, value]) => value !== null && value !== "")
        .map(([field, value]) => ({ field, value: value as string, ...locate(pages, value as string) })),
    };
  });
}
