/**
 * Phone normalisation to E.164, India first.
 *
 * This matters more than it looks. The number transcribed from a paper form is
 * the only way the person will ever reach the withdrawal portal, so a number
 * that cannot be normalised is a hard validation error at review time rather
 * than something stored as-is - storing "98765 4321" would silently make DPDP
 * s.6(4) unsatisfiable for that person, with nothing anywhere to show it.
 */

const DEFAULT_COUNTRY_CODE = "91";

/** Indian mobile numbers are ten digits beginning 6-9. */
const INDIAN_MOBILE = /^[6-9][0-9]{9}$/;

/** E.164: a leading +, a non-zero first digit, 8 to 15 digits in total. */
const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Returns the E.164 form, or null when the input cannot be normalised
 * confidently. Never guesses: a number it cannot place is rejected so a human
 * looks at the scan again.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Strip everything a person might write around the digits.
  let s = raw.trim().replace(/[\s()\-.‐-―]/g, "");
  if (s === "") return null;

  // 00 is the other international prefix in common use.
  if (s.startsWith("00")) s = `+${s.slice(2)}`;

  if (s.startsWith("+")) {
    return E164.test(s) ? s : null;
  }

  if (!/^[0-9]+$/.test(s)) return null;

  // Domestic trunk prefix: 09876543210.
  if (s.length === 11 && s.startsWith("0")) s = s.slice(1);

  // Bare ten-digit mobile.
  if (INDIAN_MOBILE.test(s)) return `+${DEFAULT_COUNTRY_CODE}${s}`;

  // Country code written without the plus: 919876543210.
  if (s.length === 12 && s.startsWith(DEFAULT_COUNTRY_CODE)) {
    const rest = s.slice(2);
    if (INDIAN_MOBILE.test(rest)) return `+${s}`;
  }

  return null;
}

/** Normalises an email for use as a lookup key, or null if it is not one. */
export function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  // Deliberately not stripping Gmail dots or +tags: collapsing two addresses
  // that belong to different people would leak one person's consent state into
  // the other's record.
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s) ? s : null;
}

/**
 * Masks a contact point for display when the portal has to disambiguate between
 * several people sharing one phone number, without handing a stranger a roster.
 */
export function maskName(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .map((part) =>
      part.length <= 1 ? part : `${part[0]}${"•".repeat(Math.min(part.length - 1, 6))}`,
    )
    .join(" ");
}
