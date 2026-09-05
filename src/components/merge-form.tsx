"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Merge, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

interface Candidate {
  id: string;
  fullName: string;
  contact: string;
  artifacts: number;
  merged: boolean;
}

/**
 * The merge picker.
 *
 * Invariant 11 says duplicates are never merged automatically, so this is
 * deliberately several steps: find the other record, read what will happen to
 * it, and say why. The reason is required because it lands in the audit entry,
 * and a merge with no stated reason is not a decision anyone can review later.
 */
export function MergeForm({
  absorbedId,
  absorbedName,
}: {
  absorbedId: string;
  absorbedName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/staff/principals/search?q=${encodeURIComponent(q)}`);
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not search");
        return;
      }
      setCandidates((body.results as Candidate[]).filter((c) => c.id !== absorbedId && !c.merged));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/staff/principals/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ absorbedId, survivorId: chosen.id, reason }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not merge these records");
        return;
      }
      router.push(`/staff/principals/${chosen.id}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Merge size={15} aria-hidden />
        Merge this record into another
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
      <p className="text-sm text-ink">
        Find the record that <strong>{absorbedName}</strong> should be folded into. Their
        paper stays where it is; their consent moves, and a withdrawal on either side is
        kept.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
          placeholder="Name, mobile number or email"
        />
        <Button variant="secondary" onClick={search} disabled={busy || q.trim().length < 2}>
          <Search size={15} aria-hidden />
          Search
        </Button>
      </div>

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
        <>
          <p className="rounded-md bg-amber-soft px-3 py-2 text-sm text-amber">
            {absorbedName} will be folded into {chosen.fullName}. This cannot be undone from
            the interface.
          </p>
          <Field
            label="Why are these the same person?"
            htmlFor="merge-reason"
            hint="Recorded in both records' audit trails."
          >
            <Input
              id="merge-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Same handwriting and address on both forms, confirmed with the branch"
            />
          </Field>
        </>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-soft px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button onClick={submit} disabled={busy || !chosen || reason.trim().length < 8}>
          {busy ? "Merging…" : "Merge records"}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
