import type { ReactNode } from "react";
import type { Tone } from "@/components/ui/badge";

const TONES: Record<Tone, string> = {
  neutral: "bg-canvas text-muted",
  blue: "bg-blue-soft text-blue",
  green: "bg-green-soft text-green",
  red: "bg-red-soft text-red",
  amber: "bg-amber-soft text-amber",
};

/**
 * A short block of consequence: an error, a confirmation, a warning.
 *
 * It exists because eleven of these were hand-rolled across six files with four
 * tones, two paddings and two text sizes - and, more to the point, with
 * `role="alert"` on the red ones only. So the amber message telling somebody
 * "we have no record of this, nothing was withdrawn" was silent to a screen
 * reader: the most consequential thing the public flow can say, announced to
 * nobody.
 *
 * `live` is deliberately not derived from `tone`. What decides it is whether the
 * message APPEARED IN RESPONSE TO SOMETHING the person just did:
 *
 *   live="alert"   something went wrong just now; interrupt. Assertive.
 *   live="status"  something finished just now; mention it. Polite.
 *   undefined      standing page content. Announcing it on load is noise, and a
 *                  page that shouts its own advisory text at every visit trains
 *                  people to ignore the ones that matter.
 */
export function Callout({
  tone = "neutral",
  live,
  icon,
  children,
}: {
  tone?: Tone;
  live?: "alert" | "status";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <p
      role={live}
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${TONES[tone]}`}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <span>{children}</span>
    </p>
  );
}
