"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";

/**
 * The shared "record what you did" control behind both worked queues.
 *
 * Every one of these actions writes an append-only audit entry, and the note is
 * required on all of them: "done" with no account of what was done is not
 * evidence, and neither queue exists for any purpose other than producing
 * evidence.
 */
export function QueueAction({
  endpoint,
  body,
  label,
  placeholder,
  minNote,
  variant = "primary",
}: {
  endpoint: string;
  body: Record<string, unknown>;
  label: string;
  placeholder: string;
  minNote: number;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, note }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "That did not work");
        return;
      }
      setOpen(false);
      setNote("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" && note.trim().length >= minNote) void submit();
        }}
      />
      {error && (
        <p role="alert" className="rounded-md bg-red-soft px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={busy || note.trim().length < minNote}>
          {busy ? "Recording…" : label}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
