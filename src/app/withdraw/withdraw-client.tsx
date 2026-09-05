"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertCircle, ArrowLeft, CheckCircle2, ShieldCheck } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { OtpInput } from "@/components/otp-input";
import { normaliseEmail, normalisePhone } from "@/lib/phone";
import { consentStatusLabels, type ConsentStatus } from "@/lib/consent";

interface WithdrawOutcome {
  purposeId: string;
  status: "withdrawn" | "declined" | "not_found";
  changed: boolean;
  withdrawnOn: string | null;
}

interface Consent {
  purposeId: string;
  name: string;
  description: string;
  dataCategories: string[];
  status: ConsentStatus;
  givenOn: string | null;
  withdrawnAt: string | null;
  formLabel: string | null;
  noticeHref: string | null;
}

type Stage = "contact" | "code" | "choose" | "consents" | "done";

/**
 * Which consents are still running is the question this whole screen exists to
 * answer, and it was previously answered in the same 12px grey as every other
 * scrap of metadata on the card - so "Active" and "Withdrawn" were
 * indistinguishable at a glance. Live consent is the state a person might want
 * to act on, so it is the one that carries colour. Withdrawn and declined are
 * both inert; the label tells them apart.
 */
const STATUS_TONE: Record<ConsentStatus, Tone> = {
  active: "green",
  withdrawn: "neutral",
  declined: "neutral",
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

/**
 * The whole withdrawal flow.
 *
 * The token lives in component state only - never a cookie and never storage -
 * so it dies with the tab and there is no ambient credential to forge a request
 * against.
 */
export function WithdrawClient() {
  const [stage, setStage] = useState<Stage>("contact");
  const [destination, setDestination] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [people, setPeople] = useState<{ id: string; maskedName: string }[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLookup, setShowLookup] = useState(false);
  const [outcomes, setOutcomes] = useState<WithdrawOutcome[]>([]);

  async function loadConsents(bearer: string) {
    const response = await fetch("/api/portal/consents", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not load your record");
      return;
    }
    setFullName(body.fullName);
    setConsents(body.consents);
    setToken(bearer);
    setStage("consents");
  }

  async function requestCode() {
    // Refuse a destination that could not receive a code no matter who it
    // belonged to.
    //
    // The server answers identically whether or not a destination is in the
    // register, which is the right call - but it meant a mistyped number went
    // straight to "we have just sent you a code" and the person then waited for
    // a code that was never sent, because normalisePhone had rejected it and no
    // challenge was ever written. A nine-digit typo is the common case.
    //
    // Checking the SHAPE here leaks nothing: whether a string looks like a phone
    // number or an email is independent of whether it is on the register, so the
    // anti-enumeration property is untouched. Uses the same normalisers the
    // server uses, so the two cannot disagree about what is reachable.
    if (normalisePhone(destination) === null && normaliseEmail(destination) === null) {
      setError(
        "That does not look like a mobile number or an email address. Check it against the form you signed.",
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/otp/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destination }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not send a code");
        return;
      }
      setChallengeId(body.challengeId);
      setCode("");
      setStage("code");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/otp/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, code }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "That code is not right");
        return;
      }
      if (body.needsSelection) {
        setPeople(body.people);
        setStage("choose");
        return;
      }
      await loadConsents(body.token);
    } finally {
      setBusy(false);
    }
  }

  async function choosePerson(principalId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/otp/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, principalId }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "That selection is no longer valid");
        return;
      }
      await loadConsents(body.token);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!token || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ purposeIds: [...selected], reason: null }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not record your withdrawal");
        return;
      }
      // A 200 does not mean anything changed. Telling someone their consent is
      // withdrawn when no record was touched is the worst failure this screen
      // has, so the confirmation is built from what the server actually did.
      setOutcomes(Array.isArray(body.outcomes) ? body.outcomes : []);
      setStage("done");
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------------------------------------------------- */

  if (stage === "done") {
    const nameFor = (purposeId: string) =>
      consents.find((c) => c.purposeId === purposeId)?.name ?? "That purpose";
    const changed = outcomes.filter((o) => o.changed);
    const alreadyWithdrawn = outcomes.filter((o) => !o.changed && o.status === "withdrawn");
    const neverGiven = outcomes.filter((o) => o.status === "declined");
    const missing = outcomes.filter((o) => o.status === "not_found");
    const somethingHappened = changed.length > 0 || alreadyWithdrawn.length > 0;

    return (
      <div className="flex flex-col gap-4">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
          {somethingHappened ? (
            <CheckCircle2 size={22} className="text-green" aria-hidden />
          ) : (
            <AlertCircle size={22} className="text-muted" aria-hidden />
          )}
          {somethingHappened
            ? "Your withdrawal is recorded"
            : "We could not withdraw anything"}
        </h1>

        {changed.length > 0 && (
          <p className="text-ink">
            We have stopped relying on your consent for{" "}
            {changed.map((o) => nameFor(o.purposeId)).join(", ")}, and we are
            instructing the systems that hold your data to do the same.
          </p>
        )}
        {alreadyWithdrawn.length > 0 && (
          <p className="text-ink">
            {alreadyWithdrawn.map((o) => nameFor(o.purposeId)).join(", ")} had already
            been withdrawn. We have recorded that you asked again.
          </p>
        )}
        {neverGiven.length > 0 && (
          <p className="text-ink">
            {neverGiven.map((o) => nameFor(o.purposeId)).join(", ")} was never given, so
            there was nothing to withdraw.
          </p>
        )}
        {missing.length > 0 && (
          // Not a success, and not silent. This usually means the register holds
          // the person under a second identity that this contact point does not
          // reach, which only a human can put right.
          <p className="rounded-md bg-amber-soft px-4 py-3 text-sm text-amber">
            We have no record of {missing.map((o) => nameFor(o.purposeId)).join(", ")} for
            you, so nothing was withdrawn for it. Your request has been logged and someone
            will look into it. Please contact us if you do not hear back.
          </p>
        )}
        {/* s.6(5) says withdrawal has no effect on processing already carried
            out. Saying so plainly is more honest than implying deletion. */}
        <p hidden={!somethingHappened} className="rounded-md bg-canvas px-4 py-3 text-sm text-muted">
          Withdrawing consent does not undo anything we did with your data before now,
          and it is not the same as deleting your data. If you want your data erased,
          that is a separate request — contact us and we will handle it.
        </p>
        <Link href="/" className="text-sm text-blue hover:underline">
          Back to the start
        </Link>
      </div>
    );
  }

  if (stage === "consents") {
    const active = consents.filter((c) => c.status === "active");
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">
            {fullName ? `Consent recorded for ${fullName}` : "Your consent record"}
          </h1>
          <p className="mt-1 text-sm text-muted">
            Everything you were asked about on paper, including what you declined.
          </p>
        </div>

        <ul className="flex flex-col gap-3">
          {consents.map((consent) => {
            const withdrawable = consent.status === "active";
            const checked = selected.has(consent.purposeId);
            return (
              <li
                key={consent.purposeId}
                className="rounded-lg border border-line bg-panel p-4"
              >
                <div className="flex items-start gap-3">
                  {withdrawable && (
                    <input
                      id={`c-${consent.purposeId}`}
                      type="checkbox"
                      checked={checked}
                      className="mt-0.5 size-5 accent-[var(--navy)]"
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(consent.purposeId);
                          else next.delete(consent.purposeId);
                          return next;
                        })
                      }
                    />
                  )}
                  <div className="flex-1">
                    <label
                      htmlFor={withdrawable ? `c-${consent.purposeId}` : undefined}
                      // Negative margin keeps the layout identical while giving
                      // the label a taller hit area than its 20px text box.
                      className={`block text-sm font-medium text-ink ${withdrawable ? "-my-2 cursor-pointer py-2" : ""}`}
                    >
                      {consent.name}
                    </label>
                    <p className="mt-0.5 text-sm text-muted">{consent.description}</p>
                    {consent.dataCategories.length > 0 && (
                      <p className="mt-1 text-xs text-muted">
                        Covers: {consent.dataCategories.join(", ")}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-muted">
                      {consent.status === "withdrawn" && consent.withdrawnAt
                        ? `Already withdrawn on ${formatDate(consent.withdrawnAt)}`
                        : consent.status === "declined"
                          ? "You did not agree to this"
                          : consent.givenOn
                            ? `Given on ${formatDate(consent.givenOn)}`
                            : "Date not recorded on the form"}
                      {consent.formLabel ? ` · ${consent.formLabel}` : ""}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[consent.status]}>
                    {consentStatusLabels[consent.status]}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ul>

        {error && (
          <p role="alert" className="rounded-md bg-red-soft px-3 py-2 text-sm text-red">
            {error}
          </p>
        )}

        {active.length === 0 ? (
          <p className="text-sm text-muted">
            There is nothing left to withdraw. Everything here is already withdrawn or was
            never agreed to.
          </p>
        ) : (
          <Button disabled={busy || selected.size === 0} onClick={withdraw}>
            {busy
              ? "Recording…"
              : `Withdraw ${selected.size || ""} ${selected.size === 1 ? "consent" : "consents"}`.trim()}
          </Button>
        )}
      </div>
    );
  }

  if (stage === "choose") {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Which record is yours?</h1>
          <p className="mt-1 text-sm text-muted">
            More than one person gave us this contact detail. Names are partly hidden.
          </p>
        </div>
        <ul className="flex flex-col gap-2">
          {people.map((person) => (
            <li key={person.id}>
              <Button
                variant="secondary"
                className="w-full justify-start"
                disabled={busy}
                onClick={() => choosePerson(person.id)}
              >
                {person.maskedName}
              </Button>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="rounded-md bg-red-soft px-3 py-2 text-sm text-red">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (stage === "code") {
    return (
      <div className="flex flex-col gap-6">
        <button
          onClick={() => {
            setStage("contact");
            setError(null);
          }}
          className="flex w-fit items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={15} aria-hidden />
          Back
        </button>
        <div>
          <h1 className="text-xl font-semibold text-ink">Enter the code</h1>
          <p className="mt-1 text-sm text-muted">
            If {destination} is on a form we hold, we have just sent a six-digit code to
            it.
          </p>
        </div>
        <OtpInput value={code} onChange={setCode} error={error ?? undefined} disabled={busy} />
        <Button disabled={busy || code.length !== 6} onClick={submitCode}>
          {busy ? "Checking…" : "Continue"}
        </Button>
        <button
          onClick={requestCode}
          disabled={busy}
          className="w-fit text-sm text-blue hover:underline disabled:opacity-60"
        >
          Send another code
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Find my consent record</h1>
        <p className="mt-1 text-sm text-muted">
          Enter the mobile number or email address you wrote on the form. We will send you
          a code to confirm it is you.
        </p>
      </div>

      <Field
        label="Mobile number or email"
        htmlFor="destination"
        hint="No account or password needed."
      >
        <Input
          id="destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && destination.trim()) void requestCode();
          }}
        />
      </Field>

      {error && (
        <p role="alert" className="rounded-md bg-red-soft px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      <Button disabled={busy || destination.trim().length < 3} onClick={requestCode}>
        {busy ? "Sending…" : "Send me a code"}
      </Button>

      <p className="flex items-start gap-2 text-xs text-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden />
        We will not tell you whether this number is on our records until you enter the
        code. That protects everyone else on the register.
      </p>

      <div className="border-t border-line pt-4">
        {showLookup ? (
          <LookupRequest onDone={() => setShowLookup(false)} />
        ) : (
          <button
            onClick={() => setShowLookup(true)}
            className="text-sm text-blue hover:underline"
          >
            Can&apos;t find your record?
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * If the number on the paper was transcribed wrongly, the code never arrives and
 * the person is stuck. This puts them in front of a human instead.
 */
function LookupRequest({ onDone }: { onDone: () => void }) {
  const [claimedName, setClaimedName] = useState("");
  const [contactNote, setContactNote] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (sent) {
    return (
      <p className="rounded-md bg-green-soft px-3 py-2 text-sm text-green">
        Thank you. Someone will get in touch to find your record.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink">
        The details on your form may have been recorded incorrectly. Tell us how to reach
        you and we will find it.
      </p>
      <Field label="Your full name" htmlFor="claimedName">
        <Input
          id="claimedName"
          value={claimedName}
          onChange={(e) => setClaimedName(e.target.value)}
        />
      </Field>
      <Field label="How can we reach you?" htmlFor="contactNote">
        <Input
          id="contactNote"
          value={contactNote}
          onChange={(e) => setContactNote(e.target.value)}
          placeholder="A phone number or email that works, and anything you remember"
        />
      </Field>
      <div className="flex gap-2">
        <Button
          disabled={busy || claimedName.trim().length < 2 || contactNote.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            try {
              await fetch("/api/portal/lookup-request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ claimedName, contactNote, formReference: null }),
              });
              setSent(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Sending…" : "Send"}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
