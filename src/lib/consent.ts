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
