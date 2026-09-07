"use client";

import { useEffect, useRef } from "react";
import { Field } from "@/components/ui/field";

/**
 * Six-digit code entry.
 *
 * One input rather than six boxes: paste works, password managers and SMS
 * autofill work, and screen readers announce one field instead of six.
 *
 * The label and error now come from `Field`, which is where the drift was: this
 * component had grown its own copy of that markup and the copy had already
 * fallen behind - no required marker, no hint slot, and `otp-error` written out
 * by hand instead of the `${htmlFor}-error` convention every other field uses.
 * Two spellings of the same contract is how the next field ends up announcing
 * nothing at all.
 *
 * The CONTROL itself is deliberately NOT `Input`. A one-time code is read back
 * off a phone one character at a time, so it is centred, twice the type size
 * and letter-spaced - a different control, not a restyled one. Forcing it
 * through `Input` would mean overriding its font size with a competing utility
 * and hoping the stylesheet ordering resolves the way we want.
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
    <Field label="Six-digit code" htmlFor="otp" error={error} required>
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
        className={`tabular w-full min-h-11 rounded-md border bg-panel px-3 py-2 text-center text-2xl tracking-[0.4em] text-ink disabled:bg-canvas ${
          error ? "border-red" : "border-line"
        }`}
      />
    </Field>
  );
}
