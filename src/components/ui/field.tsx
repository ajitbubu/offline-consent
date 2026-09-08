import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/**
 * text-base, not text-sm, and min-h-11.
 *
 * iOS zooms the whole page when a focused input's font-size is under 16px, so a
 * 14px control means every tap on a field jerks the layout and the person has
 * to pinch back out. That is worst on the withdrawal portal, which is mostly
 * used on a phone by someone exercising a statutory right - the one flow where
 * friction is the thing the Act is trying to remove.
 *
 * min-h-11 is 44px, the floor for a touch target. These controls measured 38px.
 */
const CONTROL =
  "w-full min-h-11 rounded-md border bg-panel px-3 py-2 text-base text-ink placeholder:text-muted disabled:bg-canvas";

/**
 * A labelled control. The error is wired to the input with aria-describedby and
 * aria-invalid so it is announced rather than merely coloured - operators work
 * through hundreds of these and some of them use a screen reader.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
        {required && <span className="text-red"> *</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p id={`${htmlFor}-error`} className="text-xs text-red">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({
  error,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  return (
    <input
      {...props}
      aria-invalid={error || undefined}
      aria-describedby={error && props.id ? `${props.id}-error` : undefined}
      className={`${CONTROL} ${error ? "border-red" : "border-line"} ${className}`}
    />
  );
}

export function Select({
  error,
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { error?: boolean }) {
  return (
    <select
      {...props}
      aria-invalid={error || undefined}
      aria-describedby={error && props.id ? `${props.id}-error` : undefined}
      className={`${CONTROL} ${error ? "border-red" : "border-line"} ${className}`}
    />
  );
}
