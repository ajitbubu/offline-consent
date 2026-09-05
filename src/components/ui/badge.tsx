import type { ReactNode } from "react";

export type Tone = "neutral" | "blue" | "green" | "red" | "amber";

const TONES: Record<Tone, string> = {
  neutral: "bg-canvas text-muted border-line",
  blue: "bg-blue-soft text-blue border-blue-soft",
  green: "bg-green-soft text-green border-green-soft",
  red: "bg-red-soft text-red border-red-soft",
  amber: "bg-amber-soft text-amber border-amber-soft",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
