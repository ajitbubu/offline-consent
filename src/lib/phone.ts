/**
 * Phone normalisation to E.164, India first.
 *
 * This matters more than it looks. The number transcribed from a paper form is
 * the only way the person will ever reach the withdrawal portal, so a number
 * that cannot be normalised is a hard validation error at review time rather
 * than something stored as-is - storing "98765 4321" would silently make DPDP
 * s.6(4) unsatisfiable for that person, with nothing anywhere to show it.
 */
import { parsePhoneNumberFromString } from "libphonenumber-js/mobile";

/** A number written with no country code is read as Indian. */
const DEFAULT_COUNTRY = "IN" as const;

/**
 * Returns the E.164 form, or null when the input cannot be normalised
 * confidently. Never guesses: a number it cannot place is rejected so a human
 * looks at the scan again.
 *
 * The metadata deliberately comes from `libphonenumber-js/mobile`, not the
 * default `min` set, and the difference is the whole point of using the library
 * at all:
 *
 *   - `min` validates only the SHAPE of a number, so a hand-rolled E.164 regex
 *     and `+9999999999999` both pass. There is no country 999.
 *   - `mobile` knows which ranges each country actually assigns, and knows
 *     which of them can receive SMS. It refuses `1234567890` — a valid Indian
 *     FIXED LINE — which is precisely the number that would pass validation,
 *     be stored, and then never receive the one-time code.
 *
 * That is the failure this module exists to prevent: a number that looks fine,
 * blocks s.6(4) for the person who owns it, and shows nothing anywhere. The
 * only contact point worth storing is one the portal can actually reach.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // parsePhoneNumberFromString absorbs the separators, brackets and the 00
  // international prefix people write on paper, and returns undefined rather
  // than throwing on anything it cannot read.
  const parsed = parsePhoneNumberFromString(raw.trim(), DEFAULT_COUNTRY);
  return parsed?.isValid() ? parsed.number : null;
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
