/**
 * Client for the `ml/` extraction service.
 *
 * Three rules, each of which is load-bearing:
 *
 *  1. **Extraction never fails the caller.** If the service is slow, down or
 *     unset, this returns null and the reviewer gets the manual entry form -
 *     which is the same screen. `intake_draft` has no 'extracting' status for
 *     exactly this reason: one degradation path, not two.
 *
 *  2. **The service never receives a database identifier** (PRD SEC-9). Tick-box
 *     labels go over the wire as an ordered list and come back by index; the
 *     mapping from index to purpose id happens here, against the catalogue rows
 *     we sent, so a compromised or confused model cannot name a purpose we did
 *     not ask about.
 *
 *  3. **Nothing here ever writes `payload`.** Extraction output lands in
 *     `intake_draft.extraction` and stays there. A value becomes consent only
 *     when a human moves it across on the review screen, and commitDraft reads
 *     `payload` alone.
 */
import "server-only";
import { env } from "@/lib/env";
import {
  EXTRACTION_SCHEMA_VERSION,
  type Extraction,
  type OcrPage,
  type OcrTokens,
  type TickBoxReading,
} from "@/lib/consent";
import { getEvidenceBytes } from "@/lib/evidence";
import type { Executor } from "@/lib/db";
import { pool } from "@/lib/db";

/**
 * OCR fails slow when it fails: a huge scan, a wedged worker, a cloud engine
 * having a bad day. The reviewer is sitting in front of the screen waiting, so
 * give up well before they do.
 */
const TIMEOUT_MS = 20_000;

export interface ExtractionResult {
  ocrTokens: OcrTokens;
  extraction: Extraction | null;
}

interface ServiceTickBox {
  index: number;
  granted: boolean | null;
  confidence: number;
  anchor_score: number;
  ink_ratio: number | null;
  page: number | null;
  bbox: [number, number, number, number] | null;
}

interface ServiceResponse {
  schema_version: number;
  engine: string;
  engine_version: string;
  pages: OcrPage[];
  tickboxes: ServiceTickBox[];
}

export const extractionConfigured = (): boolean => env.ML_SERVICE_URL !== undefined;

/**
 * The printed wording beside each tick-box on a notice version. This is what the
 * service matches against - printed text, which is the part OCR is reliably good
 * at, as opposed to the handwriting in the fields.
 */
export async function labelsForNotice(
  noticeId: string,
  executor: Executor = pool,
): Promise<{ purposeId: string; text: string }[]> {
  const { rows } = await executor.query<{ purpose_id: string; printed_label: string }>(
    `SELECT purpose_id, printed_label
       FROM consent_notice_purpose
      WHERE notice_id = $1
      ORDER BY display_order, purpose_id`,
    [noticeId],
  );
  return rows.map((r) => ({ purposeId: r.purpose_id, text: r.printed_label }));
}

/**
 * Runs a scan through the service. Returns null when extraction is unavailable
 * or fails for any reason - callers must treat that as "no pre-fill", never as
 * an error worth showing.
 */
export async function extract(
  evidence: { id: string; storageKey: string; contentType: string },
  labels: readonly { purposeId: string; text: string }[] = [],
): Promise<ExtractionResult | null> {
  const base = env.ML_SERVICE_URL;
  if (base === undefined) return null;

  let bytes: Buffer;
  try {
    bytes = await getEvidenceBytes(evidence.storageKey);
  } catch (error) {
    console.error("Extraction: could not read evidence bytes", evidence.id, error);
    return null;
  }

  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type: evidence.contentType }), "scan");
  form.set("content_type", evidence.contentType);
  // Index only. The service is told nothing it could use to name a purpose.
  form.set(
    "labels",
    JSON.stringify(labels.map((label, index) => ({ index, text: label.text }))),
  );

  let body: ServiceResponse;
  try {
    const response = await fetch(new URL("/extract", base), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("Extraction: service returned", response.status, await response.text());
      return null;
    }
    body = (await response.json()) as ServiceResponse;
  } catch (error) {
    console.error("Extraction: service unreachable", error);
    return null;
  }

  if (!Array.isArray(body.pages)) {
    console.error("Extraction: malformed response", body);
    return null;
  }

  const capturedAt = new Date().toISOString();
  const ocrTokens: OcrTokens = {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    engine: body.engine,
    engineVersion: body.engine_version,
    capturedAt,
    pages: body.pages,
  };

  if (labels.length === 0) return { ocrTokens, extraction: null };

  // Map index back onto the catalogue rows WE sent. A reading whose index does
  // not correspond to a label we asked about is dropped rather than trusted.
  const tickboxes: TickBoxReading[] = [];
  for (const reading of body.tickboxes ?? []) {
    const label = labels[reading.index];
    if (label === undefined) {
      console.error("Extraction: reading for an index we did not send", reading.index);
      continue;
    }
    tickboxes.push({
      purposeId: label.purposeId,
      granted: reading.granted,
      confidence: reading.confidence,
      anchorScore: reading.anchor_score,
      inkRatio: reading.ink_ratio,
      page: reading.page,
      bbox: reading.bbox,
    });
  }

  return {
    ocrTokens,
    extraction: {
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      engine: body.engine,
      engineVersion: body.engine_version,
      extractedAt: capturedAt,
      tickboxes,
    },
  };
}
