"use client";

import { useEffect, useRef } from "react";

/**
 * Six-digit code entry.
 *
 * One input rather than six boxes: paste works, password managers and SMS
 * autofill work, and screen readers announce one field instead of six.
 */
export function OtpInput({
  value,
  onChange,
  error,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // Move focus to the field when a code is rejected, so the correction can be
  // typed straight away rather than hunted for.
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="otp" className="text-sm font-medium text-ink">
        Six-digit code
      </label>
      <input
        ref={ref}
        id="otp"
        name="one-time-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        disabled={disabled}
        value={value}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? "otp-error" : undefined}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        className={`tabular w-full rounded-md border bg-panel px-3 py-2 text-center text-2xl tracking-[0.4em] text-ink disabled:bg-canvas ${
          error ? "border-red" : "border-line"
        }`}
      />
      {error && (
        <p id="otp-error" className="text-xs text-red">
          {error}
        </p>
      )}
    </div>
  );
}
