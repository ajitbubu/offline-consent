/**
 * The consent domain: status vocabularies, their labels, and the shared Zod
 * helpers. Deliberately free of database and React imports so it can be used
 * from server code, client components and tests alike.
 *
 * DPDP Act 2023 vocabulary throughout: the person is the Data Principal, the
 * organisation holding the consent is the Data Fiduciary.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Consent state                                                              */
/* -------------------------------------------------------------------------- */

export const CONSENT_STATUSES = ["active", "withdrawn", "declined"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
export const isConsentStatus = (v: unknown): v is ConsentStatus =>
  typeof v === "string" && (CONSENT_STATUSES as readonly string[]).includes(v);

export const consentStatusLabels: Record<ConsentStatus, string> = {
  active: "Active",
  withdrawn: "Withdrawn",
  declined: "Not given",
};

export const WITHDRAWAL_CHANNELS = ["portal", "staff", "letter"] as const;
export type WithdrawalChannel = (typeof WITHDRAWAL_CHANNELS)[number];

/* -------------------------------------------------------------------------- */
/* Intake                                                                     */
/* -------------------------------------------------------------------------- */

export const DRAFT_STATUSES = ["needs_review", "committed", "rejected"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export const isDraftStatus = (v: unknown): v is DraftStatus =>
  typeof v === "string" && (DRAFT_STATUSES as readonly string[]).includes(v);

export const draftStatusLabels: Record<DraftStatus, string> = {
  needs_review: "Needs review",
  committed: "Committed",
  rejected: "Rejected",
};

/**
 * `needs_review` loops to itself because editing a draft is a transition to the
 * same state. `committed` and `rejected` are terminal: a committed draft that
 * turns out to be wrong is corrected by a NEW draft superseding it, never by
 * reopening this one, because the artifact it produced can never be edited.
 */
export const allowedDraftTransitions: Record<DraftStatus, readonly DraftStatus[]> = {
  needs_review: ["needs_review", "committed", "rejected"],
  committed: [],
  rejected: [],
};

export function canTransitionDraft(from: DraftStatus, to: DraftStatus): boolean {
  return allowedDraftTransitions[from].includes(to);
}

export const INTAKE_SOURCES = ["manual", "scan", "bulk_csv", "kiosk"] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];

export const intakeSourceLabels: Record<IntakeSource, string> = {
  manual: "Manual entry",
  scan: "Scanned form",
  bulk_csv: "Bulk import",
  kiosk: "Kiosk capture",
};

/** consent_artifact.intake_mode. `scan` becomes `scan_reviewed` once committed. */
export const INTAKE_MODES = ["manual", "scan_reviewed", "bulk_csv", "kiosk"] as const;
export type IntakeMode = (typeof INTAKE_MODES)[number];

export const intakeModeForSource: Record<IntakeSource, IntakeMode> = {
  manual: "manual",
  scan: "scan_reviewed",
  bulk_csv: "bulk_csv",
  kiosk: "kiosk",
};

/* -------------------------------------------------------------------------- */
/* Notice and dating                                                          */
/* -------------------------------------------------------------------------- */

export const NOTICE_AT_COLLECTION = [
  "attached",
  "printed_on_form",
  "none",
  "unknown",
] as const;
export type NoticeAtCollection = (typeof NOTICE_AT_COLLECTION)[number];

export const noticeAtCollectionLabels: Record<NoticeAtCollection, string> = {
  attached: "Notice attached to the form",
  printed_on_form: "Notice printed on the form",
  none: "No notice given",
  unknown: "Not recorded",
};

/**
 * A form carrying no notice is not a data-entry gap - it is the ordinary case
 * for paper collected before the Act, and it is what obliges the Fiduciary to
 * give notice under s.5(2). These two values feed the notice-owed queue.
 */
export const noticeOwed = (v: NoticeAtCollection): boolean =>
  v === "none" || v === "unknown";

export const DATE_PRECISIONS = ["day", "month", "year", "unknown"] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

export const datePrecisionLabels: Record<DatePrecision, string> = {
  day: "Exact date",
  month: "Month and year only",
  year: "Year only",
  unknown: "Undated form",
};

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Shapes stored in intake_draft.ocr_tokens and intake_draft.extraction.
 *
 * They live here rather than in extraction.ts because the review screen is a
 * client component and extraction.ts is server-only - and because the review
 * screen IS the annotation tool, so these types are read on both sides.
 *
 * Bumped when the stored shape changes, so an old blob stays readable.
 *
 *   1  {schemaVersion, engine, engineVersion, extractedAt, tickboxes:[...]}
 *   2  adds `fields: [{key, value, confidence, anchorScore, method, page, bbox}]`
 *      - the handwritten name, phone, email and date read off the scan.
 *      `value: null` means NOT READ, never "blank"; a version-1 blob has no
 *      `fields` key at all, which is a third state a reader must not confuse
 *      with either. That distinction is the whole reason this number moved:
 *      leaving both shapes stamped 1 would make a row's own version stamp a
 *      lie, in the column that IS the training corpus and the evidence.
 */
export const EXTRACTION_SCHEMA_VERSION = 2;

export interface OcrToken {
  text: string;
  /** [x0, y0, x1, y1], top-left origin, in this page's pixel space. */
  bbox: [number, number, number, number];
  confidence: number;
}

export interface OcrPage {
  page: number;
  width: number;
  height: number;
  tokens: OcrToken[];
}

/**
 * Self-describing on purpose: page dimensions travel with the tokens expressed
 * in them, because a bbox means nothing without its coordinate space and
 * evidence_object records no geometry.
 */
export interface OcrTokens {
  schemaVersion: number;
  engine: string;
  engineVersion: string;
  capturedAt: string;
  pages: OcrPage[];
}

export interface TickBoxReading {
  purposeId: string;
  /**
   * null means the printed label could not be found on the scan at all, which
   * is NOT the same as finding the box and seeing it empty. Collapsing the two
   * would turn a failed match into a recorded refusal.
   */
  granted: boolean | null;
  confidence: number;
  anchorScore: number;
  inkRatio: number | null;
  page: number | null;
  bbox: [number, number, number, number] | null;
}

/**
 * One handwritten field read off the scan.
 *
 * `value` is null for "not read", never for "blank". A failed read and a field
 * the person genuinely left empty are different facts, and the review screen
 * shows them differently - the same distinction `granted: null` draws on a
 * tick-box.
 */
export interface ExtractedField {
  /** Matches a key in DraftPayload, so a reviewer can accept it in one move. */
  key: "fullName" | "phone" | "email" | "collectedOn";
  value: string | null;
  confidence: number;
  anchorScore: number;
  /** "pattern" is deterministic; "anchored" depends on the printed label. */
  method: "pattern" | "anchored" | null;
  page: number | null;
  bbox: [number, number, number, number] | null;
}

/** What the service proposed. Never committed; a human moves it into payload. */
export interface Extraction {
  schemaVersion: number;
  engine: string;
  engineVersion: string;
  extractedAt: string;
  tickboxes: TickBoxReading[];
  fields: ExtractedField[];
}

/**
 * Below this, a reading is shown to the reviewer but never pre-fills a box.
 * A wrong pre-fill is worse than an empty one: reviewers stop checking things
 * that are usually right, and this is the field that decides whether an
 * organisation may process someone's data.
 */
export const PREFILL_MIN_CONFIDENCE = 0.7;

/* -------------------------------------------------------------------------- */
/* Staff roles                                                                */
/* -------------------------------------------------------------------------- */

export const STAFF_ROLES = ["operator", "dpo", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const isStaffRole = (v: unknown): v is StaffRole =>
  typeof v === "string" && (STAFF_ROLES as readonly string[]).includes(v);

export const staffRoleLabels: Record<StaffRole, string> = {
  operator: "Operator",
  dpo: "Data Protection Officer",
  admin: "Administrator",
};

/** Role ranking. `dpo` can do everything an `operator` can, and `admin` all of it. */
const ROLE_RANK: Record<StaffRole, number> = { operator: 1, dpo: 2, admin: 3 };

export const roleAtLeast = (role: StaffRole, minimum: StaffRole): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[minimum];

/* -------------------------------------------------------------------------- */
/* Shared schemas and helpers                                                 */
/* -------------------------------------------------------------------------- */

export const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the six-digit code");

export const uuidSchema = z.string().uuid();

/** Flattens a ZodError into { field: message } for rendering beside inputs. */
export function getZodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** A validation finding on a draft. Errors block commit; warnings do not. */
export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  field: string;
  severity: ValidationSeverity;
  message: string;
}

export const hasBlockingError = (issues: readonly ValidationIssue[]): boolean =>
  issues.some((i) => i.severity === "error");
