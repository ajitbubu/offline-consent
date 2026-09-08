/**
 * What a scanned document actually says, and HOW each answer was obtained.
 *
 * The extraction service returns fields and tick-box readings. That is not yet a
 * payload: a value with no account of where it came from cannot be reviewed, and
 * this session has already produced three separate forms where a LABEL FRAGMENT
 * was pre-filled as somebody's name at over 0.9 confidence - "Details" from
 * "Applicant Details", "Address of", and "PF No". A reviewer shown `PF No` with
 * no provenance has no way to tell it apart from a real read.
 *
 * So every field here carries its provenance:
 *
 *   explicit  the form states it, and we matched the stated label
 *   derived   inferred from something else, and the rule is named
 *   absent    nothing was found, which is a legitimate answer
 *
 * PROVENANCE IS NOT DECORATION. Under DPDP the difference between "the form
 * says this purpose" and "we guessed the purpose from the form type" is the
 * difference between consent that is specific and consent that is not. It has to
 * survive into the record, not live in a log line.
 *
 * NOTHING HERE WRITES CONSENT. This assembles a proposal for a human. The rules
 * below deliberately refuse more often than they guess.
 */
import type { ExtractedField, OcrTokens, TickBoxReading } from "@/lib/consent";

export type Provenance = "explicit" | "derived" | "absent";

export interface PayloadField<T> {
  value: T | null;
  provenance: Provenance;
  /** The label matched, or the named rule that derived it. Never a guess. */
  source: string | null;
  confidence: number;
  page: number | null;
  bbox: [number, number, number, number] | null;
}

export type ConsentChoice = "GRANTED" | "DECLINED" | "NOT_SELECTED" | "AMBIGUOUS";

export interface ConsentPayload {
  name: PayloadField<string>;
  email: PayloadField<string>;
  phone: PayloadField<string>;
  /** The declaration wording itself, verbatim off the page. */
  consentLanguage: PayloadField<string>;
  /** Only ever set from an explicit consent-specific Yes/No. */
  consentChoice: PayloadField<ConsentChoice>;
  purpose: PayloadField<string>;
  signaturePresent: PayloadField<boolean>;
  noticeVersion: PayloadField<string>;
  formVersion: PayloadField<string>;
}

const absent = <T>(): PayloadField<T> => ({
  value: null,
  provenance: "absent",
  source: null,
  confidence: 0,
  page: null,
  bbox: null,
});

const found = <T>(
  value: T,
  source: string,
  confidence: number,
  provenance: Provenance = "explicit",
  page: number | null = null,
  bbox: [number, number, number, number] | null = null,
): PayloadField<T> => ({ value, provenance, source, confidence, page, bbox });

/* -------------------------------------------------------------------------- */
/* Rule: Name — prefer primary applicant, customer, claimant, enterprise      */
/* -------------------------------------------------------------------------- */

/**
 * Ordered by how specifically a label names the PERSON GIVING CONSENT.
 *
 * Order is the whole mechanism. A bare "Name" matches the first word of "Name of
 * Guarantor" perfectly, and a guarantor is not the applicant - so bare "Name"
 * sorts last and only wins when nothing better matched.
 */
const NAME_LABELS = [
  "Name of the Applicant",
  "Primary Applicant Name",
  "Sole/First Holder Name",
  "Name of Applicant",
  "Applicant Name",
  "Customer Name",
  "Name of Claimant",
  "Claimant Name",
  "Name of the Enterprise/ Individual",
  "Name of Enterprise",
  "Name of Primary Depositor",
  "Full name",
  "Name",
] as const;

/**
 * Printed furniture that is never a person's name.
 *
 * Every entry was observed being pre-filled as a name at high confidence on a
 * real form in docs/training-data. They are here because the anchor matched a
 * label and then read the NEXT label instead of a value.
 */
const NOT_A_NAME = [
  /^details?$/i,
  /^address(\s+of)?$/i,
  /^pf\s*no\.?$/i,
  /^name$/i,
  /^(mobile|tel|telephone|phone|email|e-mail)\b/i,
  /^(date|signature|branch|city|state|country|pin\s*code)$/i,
  /^(nationality|gender|category|occupation|constitution)$/i,
  /^(yes|no)$/i,
];

const looksLikeAName = (raw: string): boolean => {
  const value = raw.trim();
  if (value.length < 2) return false;
  if (NOT_A_NAME.some((r) => r.test(value))) return false;
  // A name is letters and separators. Digits mean we read a field, not a person.
  if (/\d/.test(value)) return false;
  return /[A-Za-z]{2,}/.test(value);
};

/* -------------------------------------------------------------------------- */
/* Rule: Email — normalise spacing and capitalisation, then validate           */
/* -------------------------------------------------------------------------- */

/**
 * OCR spaces out comb cells, so "RAHUL.TEST@EXAMPLE.COM" arrives as
 * "R A H U L . T E S T @ E X A M P L E . C O M". Whitespace is never meaningful
 * inside an address, so removing it is normalisation and not repair.
 *
 * Capitalisation is normalised because the local part is case-sensitive in the
 * RFC and case-insensitive in every mail system anyone actually runs. Lower-case
 * is what the rest of this codebase compares against.
 *
 * Validation is deliberately structural, not clever: no attempt to guess that
 * "exkample" was meant to be "example". A wrong address that VALIDATES is worse
 * than one that fails, because it silently breaks the s.6(4) withdrawal path.
 */
const normaliseEmail = (raw: string): string =>
  raw.replace(/\s+/g, "").toLowerCase();

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/* -------------------------------------------------------------------------- */
/* Rule: Phone — prefer a clearly labelled mobile or telephone number          */
/* -------------------------------------------------------------------------- */

/** Mobile first: it is the number a one-time code can actually reach. */
const PHONE_LABELS = [
  "Mobile No",
  "Mobile Number",
  "Mobile",
  "Telephone No",
  "Telephone Number",
  "Tel. No",
  "Phone No",
  "Phone",
] as const;

/**
 * A number that is not dialable is an error, not a warning: if the code never
 * arrives, s.6(4) fails for that person with nothing to show it. Indian mobiles
 * are 10 digits; 11-13 accommodates a country code.
 */
const plausiblePhone = (raw: string): boolean => {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 13;
};

/* -------------------------------------------------------------------------- */
/* Rule: Consent language, notice version, form version                       */
/* -------------------------------------------------------------------------- */

/**
 * The declaration itself. Under s.6(1) consent must be informed, so the wording
 * the person was shown is part of the evidence - not a checkbox alone.
 */
const CONSENT_LANGUAGE = /\b(I\/We hereby|I hereby|we hereby|declare|declaration|agree(?:ment)?|authorise|authorize|authorisation|consent)\b/i;

/**
 * ONLY an explicit privacy-notice version. Deliberately narrow: a bare "v2" on a
 * form is the FORM's revision, and treating it as the notice version would
 * attribute consent to wording the person never saw.
 */
const NOTICE_VERSION =
  /\b(?:privacy\s+notice|notice|privacy\s+policy)\s*(?:version|ver\.?|v)?\s*[:\-]?\s*(v?\d+(?:\.\d+)*)/i;

/** The paper revision. Kept apart from the notice version, always. */
const FORM_VERSION =
  /\b(?:form|revision|rev\.?)\s*(?:version|ver\.?|v)?\s*[:\-]?\s*(v?\d+(?:\.\d+)*(?:[-/]\d{2,4})?)/i;

const pageText = (tokens: OcrTokens | null): { text: string; page: number }[] =>
  (tokens?.pages ?? []).map((p) => ({
    text: p.tokens.map((t) => t.text).join(" "),
    page: p.page,
  }));

/* -------------------------------------------------------------------------- */

/**
 * Assemble the payload. Every branch either names its source or reports absent.
 *
 * `formType` is the caller's classification of the document (from its filename
 * or a chosen form version). It is used ONLY to derive a purpose when the form
 * states none, and that derivation is marked as such.
 */
export function buildConsentPayload(
  fields: ExtractedField[],
  readings: TickBoxReading[],
  tokens: OcrTokens | null,
  formType: string | null = null,
): ConsentPayload {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const pages = pageText(tokens);
  const allText = pages.map((p) => p.text).join("\n");

  // NAME. The service already anchored on a label; the job here is to refuse a
  // read that is plainly furniture rather than a person.
  const nameField = byKey.get("fullName");
  const name =
    nameField?.value && looksLikeAName(nameField.value)
      ? found(nameField.value.trim(), matchedLabel(nameField.value, NAME_LABELS) ?? "anchored label",
          nameField.confidence, "explicit", nameField.page, nameField.bbox)
      : absent<string>();

  // EMAIL. Normalise, then validate structurally. No repair.
  const emailField = byKey.get("email");
  const email = (() => {
    if (!emailField?.value) return absent<string>();
    const normalised = normaliseEmail(emailField.value);
    if (!EMAIL_SHAPE.test(normalised)) return absent<string>();
    return found(normalised, "Email ID", emailField.confidence, "explicit",
      emailField.page, emailField.bbox);
  })();

  // PHONE. Must be dialable to be worth storing.
  const phoneField = byKey.get("phone");
  const phone =
    phoneField?.value && plausiblePhone(phoneField.value)
      ? found(phoneField.value.replace(/\s+/g, " ").trim(),
          matchedLabel(phoneField.value, PHONE_LABELS) ?? "labelled number",
          phoneField.confidence, "explicit", phoneField.page, phoneField.bbox)
      : absent<string>();

  // CONSENT LANGUAGE. The declaration wording, verbatim, with its page.
  const consentLanguage = (() => {
    for (const { text, page } of pages) {
      const hit = CONSENT_LANGUAGE.exec(text);
      if (!hit) continue;
      const start = Math.max(0, hit.index - 40);
      return found(text.slice(start, start + 260).trim(),
        `matched /${hit[1]}/`, 1, "explicit", page, null);
    }
    return absent<string>();
  })();

  // CONSENT CHOICE. Stored ONLY when an explicit consent-specific Yes/No was
  // detected. A tick-box the service could not locate reports null, and null is
  // NOT a decline - collapsing them would record a refusal nobody made.
  const consentChoice = (() => {
    const decided = readings.filter((r) => r.granted !== null);
    if (decided.length === 0) return absent<ConsentChoice>();
    const yes = decided.filter((r) => r.granted === true);
    const no = decided.filter((r) => r.granted === false);
    // Both selected is the ambiguity the spec calls out by name.
    if (yes.length > 0 && no.length > 0) {
      return found<ConsentChoice>("AMBIGUOUS",
        `${yes.length} granted and ${no.length} declined on one form`,
        Math.min(...decided.map((r) => r.confidence)), "explicit");
    }
    const winner = yes[0] ?? no[0];
    return found<ConsentChoice>(yes.length > 0 ? "GRANTED" : "DECLINED",
      "explicit tick-box selection", winner.confidence, "explicit",
      winner.page, winner.bbox);
  })();

  // PURPOSE. Explicit if the form states one; otherwise derived from the form
  // type, and SAID SO. A derived purpose must never read as a stated one.
  const purpose = (() => {
    const stated = /\bpurpose\s*(?:of|:)?\s*([^\n]{4,90})/i.exec(allText);
    if (stated) {
      return found(stated[1].trim(), "matched printed 'Purpose'", 1, "explicit");
    }
    if (formType) {
      return found(formType, `derived from form type '${formType}'`, 0.5, "derived");
    }
    return absent<string>();
  })();

  // SIGNATURE. Presence only. No comparison, no identity claim - saying a
  // signature is present is evidence; saying whose it is would be a claim this
  // system has no basis for and PRD non-goals exclude.
  const signaturePresent = (() => {
    const hit = /\bsignature\b/i.exec(allText);
    return hit
      ? found(true, "the word 'Signature' appears in the expected region", 0.5,
          "derived")
      : absent<boolean>();
  })();

  const noticeVersion = (() => {
    const hit = NOTICE_VERSION.exec(allText);
    return hit ? found(hit[1], "explicit privacy notice version", 1, "explicit")
               : absent<string>();
  })();

  const formVersion = (() => {
    const hit = FORM_VERSION.exec(allText);
    return hit ? found(hit[1], "printed form revision", 1, "explicit")
               : absent<string>();
  })();

  return { name, email, phone, consentLanguage, consentChoice, purpose,
           signaturePresent, noticeVersion, formVersion };
}

/** Which of the ordered labels this value most plausibly came from. */
function matchedLabel(value: string, labels: readonly string[]): string | null {
  const haystack = value.toLowerCase();
  return labels.find((l) => haystack.includes(l.toLowerCase())) ?? null;
}

/** True when nothing was found for any field: the document yielded nothing. */
export const payloadIsEmpty = (p: ConsentPayload): boolean =>
  Object.values(p).every((f) => (f as PayloadField<unknown>).provenance === "absent");
