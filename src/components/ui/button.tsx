import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-navy text-white hover:bg-ink disabled:bg-muted",
  secondary: "bg-panel text-ink border border-line hover:bg-canvas",
  danger: "bg-red text-white hover:brightness-90",
  ghost: "text-blue hover:bg-blue-soft",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      // min-h-11 is the 44px touch-target floor; these measured 36px.
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
    />
  );
}
