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
  type ExtractedField,
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
  fields?: ServiceField[];
}

interface ServiceField {
  key: string;
  value: string | null;
  confidence: number;
  anchor_score: number;
  method: "pattern" | "anchored" | null;
  page: number | null;
  bbox: [number, number, number, number] | null;
}

/**
 * The printed wording beside each handwritten field, and how to find its value.
 *
 * These are WORDING, not identifiers - the same rule tick-box labels follow, so
 * the service still never sees anything it could use to name a database row.
 * Several spellings per field because forms are inconsistent: "Mobile",
 * "Mobile No." and "Phone" are all the same box.
 *
 * Hard-coded rather than configurable because the keys have to line up with
 * DraftPayload for a reviewer to accept a value in one move, and a mismatch
 * would be silent. When a form uses wording that is not here, the honest fix is
 * to add the spelling, not to loosen the matcher: a loose matcher pre-fills the
 * wrong field, which is worse than pre-filling nothing.
 */
const FIELD_REQUESTS = [
  {
    key: "fullName",
    kind: "text",
    // Harvested from 146 real Indian bank forms by ml/scripts/harvest_labels.py,
    // which reads BOTH colon-punctuated labels and table-cell labels - the
    // second sweep is what found SMBC's "Name of the Enterprise/ Individual",
    // a whole geometry that contributed no vocabulary at all before.
    // "Name" stays LAST: the anchor keeps the best-scoring label, and a bare
    // "Name" matches the first word of "Name of Guarantor" perfectly.
    // Guarantor, Co-Applicant and Second/Third Holder are deliberately absent -
    // they are real labels on these forms and they are not the applicant.
    labels: ["Sole/First Holder Name", "Name of Applicant", "Name of Primary Depositor", "Applicant Name", "Name of the Enterprise/ Individual", "First Name", "Full name", "Name (Same as ID Proof)", "Member name", "Name"],
  },
  { key: "phone", kind: "phone", labels: ["Mobile No", "Mobile Number", "Mobile", "Telephone No", "Telephone Number", "Phone No", "Phone", "Telephone", "Contact number", "Tel"] },
  { key: "email", kind: "email", labels: ["Email ID", "E-mail ID", "Email address", "Email", "E-mail"] },
  { key: "collectedOn", kind: "date", labels: ["Date (DD/MM/YYYY)", "Date signed", "Signed", "Dated", "Date"] },
] as const;

const FIELD_KEYS = new Set(FIELD_REQUESTS.map((f) => f.key));

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
  // Asked for on every scan, with or without a notice version: a name and a
  // phone number do not depend on knowing which printed form this is, and the
  // reviewer benefits from them either way.
  form.set("fields", JSON.stringify(FIELD_REQUESTS));

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

  // Only keys we actually asked for. A result for anything else is dropped
  // rather than trusted: the app decides what a field means, not the service.
  const fields: ExtractedField[] = [];
  for (const field of body.fields ?? []) {
    if (!FIELD_KEYS.has(field.key as ExtractedField["key"])) {
      console.error("Extraction: field we did not ask for", field.key);
      continue;
    }
    fields.push({
      key: field.key as ExtractedField["key"],
      value: field.value,
      confidence: field.confidence,
      anchorScore: field.anchor_score,
      method: field.method,
      page: field.page,
      bbox: field.bbox,
    });
  }

  if (labels.length === 0 && fields.length === 0) {
    return { ocrTokens, extraction: null };
  }

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
      fields,
    },
  };
}
