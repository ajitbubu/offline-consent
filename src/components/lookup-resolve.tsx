"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, Input } from "@/components/ui/field";

interface Candidate {
  id: string;
  fullName: string;
  contact: string;
  artifacts: number;
  merged: boolean;
}

/**
 * Closing a lookup request against the person it turned out to be.
 *
 * The search is seeded with the name the requester claimed, because that is the
 * only thing known about them - but it stays editable, since the whole reason
 * they are in this queue is that what was written down did not match. A
 * transcription that produced "Ravi Shankar" from "Ravi Chandran" will not be
 * found by searching the claimed name either.
 *
 * Merged records are filtered out of the results: resolving onto a record that
 * has been folded into another would point the trail at a row that no longer
 * holds anyone's consent.
 */
export function LookupResolve({
  requestId,
  claimedName,
}: {
  requestId: string;
  claimedName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(claimedName);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/staff/principals/search?q=${encodeURIComponent(q)}`,
      );
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not search");
        return;
      }
      setCandidates((body.results as Candidate[]).filter((c) => !c.merged));
      setSearched(true);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/staff/lookup-requests/${requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resolve", principalId: chosen.id, note }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not resolve this request");
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <UserCheck size={15} aria-hidden />
        Found them
      </Button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
          placeholder="Name, mobile number or email"
          aria-label="Search the register"
        />
        <Button
          variant="secondary"
          onClick={search}
          disabled={busy || q.trim().length < 2}
        >
          <Search size={15} aria-hidden />
          Search
        </Button>
      </div>

      {searched && candidates.length === 0 && (
        <Callout tone="amber" live="status">
          Nothing matched. Try the number or email they gave in their note - what was
          written on the form is exactly what is likely to be wrong.
        </Callout>
      )}

      {candidates.length > 0 && (
        <ul className="flex flex-col gap-1">
          {candidates.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setChosen(c)}
                className={`flex w-full items-start gap-2 rounded-md border p-2 text-left ${
                  chosen?.id === c.id ? "border-navy bg-canvas" : "border-line"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{c.fullName}</span>
                  <span className="block truncate text-xs text-muted">
                    {c.contact || "No contact point"} · {c.artifacts} form
                    {c.artifacts === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {chosen && (
        <Field
          label="How did you match them?"
          htmlFor={`lookup-note-${requestId}`}
          hint="Recorded against that person's audit trail."
        >
          <Input
            id={`lookup-note-${requestId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Form reference matched the membership number in their note"
          />
        </Field>
      )}

      {error && (
        <Callout tone="red" live="alert">
          {error}
        </Callout>
      )}

      <div className="flex gap-2">
        <Button onClick={submit} disabled={busy || !chosen || note.trim().length < 4}>
          {busy ? "Recording…" : "Resolve"}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
