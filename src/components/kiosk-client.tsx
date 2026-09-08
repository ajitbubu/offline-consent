"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, Input, Select } from "@/components/ui/field";
import { SignaturePad, signatureBlob } from "@/components/signature-pad";

interface NoticePurpose { purpose_id: string; printed_label: string }
interface Notice { id: string; label: string; purposes: NoticePurpose[] }

type Stage = "setup" | "welcome" | "details" | "consent" | "sign" | "done";

/** FR-16. A tablet left alone must not still be showing the last person's form. */
const IDLE_MS = 90_000;
const WARN_AT_MS = 15_000;

/**
 * The counter tablet.
 *
 * It produces an intake_draft like every other intake mode and stops there.
 * There is deliberately no commit here: the person in front of the tablet is the
 * Data Principal, not the reviewer, and nothing enters the register without a
 * member of staff confirming it against what was actually signed.
 *
 * The idle reset is a data-protection control, not a convenience. An unattended
 * tablet still showing the previous person's name, phone number and consent
 * choices discloses them to whoever walks up next, and a counter is exactly
 * where that happens.
 */
export function KioskClient({ notices }: { notices: Notice[] }) {
  const [stage, setStage] = useState<Stage>("setup");
  const [notice, setNotice] = useState<Notice | null>(notices[0] ?? null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [hasInk, setHasInk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /** Wipes everything the last person entered. */
  const reset = useCallback(() => {
    setFullName("");
    setPhone("");
    setEmail("");
    setGranted({});
    setHasInk(false);
    setError(null);
    setSecondsLeft(null);
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && canvasRef.current) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    setStage("welcome");
  }, []);

  // Idle timer. Runs only while somebody's data is on screen - the welcome and
  // setup screens hold nothing worth wiping, and a tablet that resets itself
  // while idle at the welcome screen is just flicker.
  const armed = stage === "details" || stage === "consent" || stage === "sign";
  useEffect(() => {
    if (!armed) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
      setSecondsLeft(null);
    };
    const events = ["pointerdown", "keydown", "input"] as const;
    events.forEach((e) => window.addEventListener(e, bump));

    const tick = setInterval(() => {
      const idle = Date.now() - last;
      if (idle >= IDLE_MS) {
        reset();
      } else if (idle >= IDLE_MS - WARN_AT_MS) {
        setSecondsLeft(Math.ceil((IDLE_MS - idle) / 1000));
      }
    }, 1000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(tick);
    };
  }, [armed, reset]);

  async function submit() {
    if (!notice) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await signatureBlob(canvasRef.current);
      let signatureEvidenceId: string | null = null;
      if (blob) {
        const body = new FormData();
        body.set("file", new File([blob], "signature.png", { type: "image/png" }));
        body.set("kind", "signature");
        const response = await fetch("/api/staff/evidence", { method: "POST", body });
        const payload = await response.json();
        if (!response.ok) {
          setError(payload.error ?? "Could not save the signature");
          return;
        }
        signatureEvidenceId = payload.id;
      }

      const response = await fetch("/api/staff/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "kiosk",
          signatureEvidenceId,
          payload: {
            principal: { fullName, phone: phone || null, phoneE164: null, email: email || null },
            noticeId: notice.id,
            // The person is standing in front of the notice on the screen, so
            // it was shown at collection. This is the one intake mode that can
            // say that honestly.
            noticeAtCollection: "printed_on_form",
            collectedOn: new Date().toLocaleDateString("en-CA"),
            collectedOnPrecision: "day",
            collectionLocation: "Counter kiosk",
            subjectDeclaration: null,
            items: notice.purposes.map((p) => ({
              purposeId: p.purpose_id,
              granted: granted[p.purpose_id] ?? false,
              verbatimLabel: p.printed_label,
            })),
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Could not save this form");
        return;
      }
      setStage("done");
      setTimeout(reset, 6000);
    } finally {
      setBusy(false);
    }
  }

  if (stage === "setup") {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <h1 className="text-xl font-semibold text-ink">Set up the counter tablet</h1>
        <p className="text-sm text-muted">
          Choose the form on the counter, then hand the tablet over. It clears itself after
          90 seconds without a touch.
        </p>
        <Field label="Which printed form is on the counter?" htmlFor="k-notice">
          <Select
            id="k-notice"
            value={notice?.id ?? ""}
            onChange={(e) => setNotice(notices.find((n) => n.id === e.target.value) ?? null)}
          >
            {notices.map((n) => (
              <option key={n.id} value={n.id}>{n.label}</option>
            ))}
          </Select>
        </Field>
        <Button onClick={() => setStage("welcome")} disabled={!notice}>
          Start
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5">
      {secondsLeft !== null && (
        <Callout tone="amber" live="status">
          Still there? This will clear itself in {secondsLeft} seconds.
        </Callout>
      )}

      {stage === "welcome" && (
        <div className="flex flex-col gap-4 text-center">
          <h1 className="text-2xl font-semibold text-ink">Record your consent</h1>
          <p className="text-ink">
            Tell us how to reach you, choose what you agree to, and sign. A member of staff
            checks it against the paper before anything is recorded.
          </p>
          <Button onClick={() => setStage("details")}>Start</Button>
        </div>
      )}

      {stage === "details" && (
        <div className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold text-ink">Your details</h1>
          <Field label="Full name" htmlFor="k-name" required>
            <Input id="k-name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="off" />
          </Field>
          <Field
            label="Mobile number"
            htmlFor="k-phone"
            hint="You will need this, or an email, to withdraw your consent later."
          >
            <Input id="k-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Email" htmlFor="k-email">
            <Input id="k-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </Field>
          <Button
            onClick={() => setStage("consent")}
            disabled={fullName.trim().length < 2 || (!phone.trim() && !email.trim())}
          >
            Next
          </Button>
        </div>
      )}

      {stage === "consent" && notice && (
        <div className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold text-ink">What do you agree to?</h1>
          <p className="text-sm text-muted">
            Tick only what you want. You can change any of this later, and saying no to
            everything is a valid answer.
          </p>
          <ul className="flex flex-col divide-y divide-line">
            {notice.purposes.map((p) => (
              <li key={p.purpose_id} className="flex items-start gap-3 py-3">
                <input
                  id={`k-${p.purpose_id}`}
                  type="checkbox"
                  checked={granted[p.purpose_id] ?? false}
                  onChange={(e) =>
                    setGranted((g) => ({ ...g, [p.purpose_id]: e.target.checked }))
                  }
                  className="mt-0.5 size-5 accent-[var(--navy)]"
                />
                <label htmlFor={`k-${p.purpose_id}`} className="-my-2 flex-1 cursor-pointer py-2 text-sm text-ink">
                  {p.printed_label}
                </label>
              </li>
            ))}
          </ul>
          <Button onClick={() => setStage("sign")}>Next</Button>
        </div>
      )}

      {stage === "sign" && (
        <div className="flex flex-col gap-4">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
            <PenLine size={20} aria-hidden />
            Sign here
          </h1>
          <SignaturePad canvasRef={canvasRef} onInkChange={setHasInk} />
          {error && (
            <Callout tone="red" live="alert">{error}</Callout>
          )}
          <Button onClick={submit} disabled={busy || !hasInk}>
            {busy ? "Saving…" : "Finish"}
          </Button>
        </div>
      )}

      {stage === "done" && (
        <div className="flex flex-col items-center gap-4 text-center">
          <CheckCircle2 size={40} className="text-green" aria-hidden />
          <h1 className="text-xl font-semibold text-ink">Thank you</h1>
          <p className="text-ink">
            A member of staff will check this against the paper. Nothing is recorded until
            they do.
          </p>
          <Button variant="secondary" onClick={reset}>
            Hand back to the next person
          </Button>
        </div>
      )}
    </div>
  );
}
