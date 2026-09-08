"use client";

/**
 * Attach a folder of documents, scan them, read the payload.
 *
 * WHY THIS SCREEN EXISTS SEPARATELY FROM /staff/review. The review screen takes
 * ONE scan and walks a person through committing it as consent. That is the
 * right shape for a form that will become a legal record and the wrong shape
 * entirely for looking at a hundred documents to find out what the extractor
 * can read. Doing the second job through the first meant a permanent consent
 * record per document, which is not a cost anyone should pay to read a number.
 *
 * So: nothing here commits. It scans, shows the payload with the provenance of
 * every field, and exports. Turning a row into consent is a deliberate move to
 * the review screen, which still owns that.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import {
  buildConsentPayload,
  type ConsentPayload,
  type PayloadField,
  type Provenance,
} from "@/lib/document-payload";
import type { ExtractedField, OcrTokens, TickBoxReading } from "@/lib/consent";

type Row = {
  file: string;
  bytes: number;
  status: "queued" | "uploading" | "scanning" | "done" | "failed";
  detail?: string;
  evidenceId?: string;
  pages?: number;
  tokens?: number;
  payload?: ConsentPayload;
};

const PROVENANCE_TONE: Record<Provenance, Tone> = {
  explicit: "green",
  derived: "amber",
  absent: "neutral",
};

const FIELD_ORDER: { key: keyof ConsentPayload; label: string; rule: string }[] = [
  { key: "name", label: "Name", rule: "Prefers primary applicant, customer, claimant or enterprise labels" },
  { key: "email", label: "Email", rule: "Spacing and capitalisation normalised, then structurally validated" },
  { key: "phone", label: "Phone", rule: "Prefers a clearly labelled mobile or telephone number" },
  { key: "consentLanguage", label: "Consent", rule: "Declaration, agreement, authorisation or consent wording" },
  { key: "consentChoice", label: "Consent choice", rule: "Stored only on an explicit consent-specific Yes/No" },
  { key: "purpose", label: "Purpose", rule: "Explicit where stated, otherwise derived and marked as derived" },
  { key: "signaturePresent", label: "Signature", rule: "Presence evidence only. The signer is never authenticated" },
  { key: "noticeVersion", label: "Notice version", rule: "Only an explicit privacy notice version" },
  { key: "formVersion", label: "Form version", rule: "Kept separate from the notice version" },
];

const show = (value: unknown): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "present" : "not present";
  return String(value);
};

export function DocumentsClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [skippedCount, setSkippedCount] = useState(0);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const update = useCallback((index: number, patch: Partial<Row>) => {
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const scan = useCallback(
    async (files: File[]) => {
      // Only what the extractor can render. Filtering here rather than at the
      // input keeps the count honest: "18 of 149 were not documents" is useful,
      // a silently shorter list is not.
      const accepted = files.filter((f) =>
        /\.(pdf|png|jpe?g|tiff?)$/i.test(f.name),
      );
      const skipped = files.length - accepted.length;

      setRows(
        accepted.map((f) => ({
          file: f.webkitRelativePath || f.name,
          bytes: f.size,
          status: "queued" as const,
        })),
      );
      setSelected(null);
      setSkippedCount(skipped);
      setRunning(true);

      for (let i = 0; i < accepted.length; i += 1) {
        const file = accepted[i];
        try {
          update(i, { status: "uploading" });
          const form = new FormData();
          form.append("file", file);
          form.append("kind", "scan");
          const up = await fetch("/api/staff/evidence", { method: "POST", body: form });
          if (!up.ok) throw new Error(`upload ${up.status}`);
          const { id } = (await up.json()) as { id: string };

          update(i, { status: "scanning", evidenceId: id });
          const res = await fetch("/api/staff/extract", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ evidenceId: id, noticeId: null }),
          });
          if (!res.ok) throw new Error(`extract ${res.status}`);
          const body = (await res.json()) as {
            ocrTokens: OcrTokens | null;
            extraction: {
              fields?: ExtractedField[];
              readings?: TickBoxReading[];
              tickboxes?: TickBoxReading[];
            } | null;
          };

          const fields = body.extraction?.fields ?? [];
          const readings = body.extraction?.readings ?? body.extraction?.tickboxes ?? [];
          // Form type comes from the filename, and is used ONLY to derive a
          // purpose when the form states none. That derivation is marked.
          const formType = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
          const payload = buildConsentPayload(fields, readings, body.ocrTokens, formType);

          update(i, {
            status: "done",
            pages: body.ocrTokens?.pages.length ?? 0,
            tokens: body.ocrTokens?.pages.reduce((n, p) => n + p.tokens.length, 0) ?? 0,
            payload,
          });
        } catch (error) {
          update(i, {
            status: "failed",
            detail: error instanceof Error ? error.message : "failed",
          });
        }
      }

      setRunning(false);
    },
    [update],
  );

  const done = rows.filter((r) => r.status === "done");

  const exportJson = () => {
    const payload = done.map((r) => ({
      file: r.file,
      evidenceId: r.evidenceId,
      pages: r.pages,
      payload: r.payload,
    }));
    download("consent-payloads.json", "application/json", JSON.stringify(payload, null, 2));
  };

  const exportCsv = () => {
    const head = ["file", ...FIELD_ORDER.flatMap((f) => [f.label, `${f.label} provenance`])];
    const lines = done.map((r) =>
      [
        r.file,
        ...FIELD_ORDER.flatMap((f) => {
          const field = r.payload?.[f.key] as PayloadField<unknown> | undefined;
          return [show(field?.value), field?.provenance ?? "absent"];
        }),
      ]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(","),
    );
    download("consent-payloads.csv", "text/csv", [head.join(","), ...lines].join("\n"));
  };

  const counts = useMemo(() => {
    const withName = done.filter((r) => r.payload?.name.value).length;
    const withChoice = done.filter((r) => r.payload?.consentChoice.value).length;
    const derived = done.filter((r) =>
      Object.values(r.payload ?? {}).some(
        (f) => (f as PayloadField<unknown>).provenance === "derived",
      ),
    ).length;
    return { withName, withChoice, derived };
  }, [done]);

  return (
    <div className="flex flex-col gap-6">
      <Panel
        title="Attach documents"
        description="A whole folder, or a selection of files. PDF, PNG, JPEG and TIFF are scanned; anything else is skipped and counted."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => folderInput.current?.click()} disabled={running}>
            Choose folder
          </Button>
          <Button
            variant="secondary"
            onClick={() => fileInput.current?.click()}
            disabled={running}
          >
            Choose files
          </Button>
          {rows.length > 0 && (
            <span className="text-sm text-muted tabular-nums">
              {done.length} of {rows.length} scanned
              {running && " — working"}
            </span>
          )}
          <input
            ref={folderInput}
            type="file"
            multiple
            // Non-standard but universally supported, and the only way a browser
            // will hand over a directory without a native host.
            {...({ webkitdirectory: "" } as Record<string, string>)}
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files;
              if (picked) scan(Array.from(picked));
              // Cleared so picking the SAME folder twice still fires change. An
              // unreset input makes every retry of a failed run do nothing.
              e.target.value = "";
            }}
          />
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files;
              if (picked) scan(Array.from(picked));
              // Cleared so picking the SAME folder twice still fires change. An
              // unreset input makes every retry of a failed run do nothing.
              e.target.value = "";
            }}
          />
        </div>

        {skippedCount > 0 && (
          // On screen, not in the console. A run where every attachment is
          // skipped produces no rows, so this is the only thing that explains
          // why the page looks like it did nothing.
          <p className="mt-3 text-sm text-amber">
            {skippedCount} attached item{skippedCount === 1 ? " was" : "s were"} not a
            PDF, PNG, JPEG or TIFF and {skippedCount === 1 ? "was" : "were"} skipped.
            {rows.length === 0 && " Nothing was left to scan."}
          </p>
        )}

        <p className="mt-3 text-sm text-muted">
          Nothing here becomes consent. Scanning reads a document and proposes a
          payload; a value only becomes a consent record through the review
          screen, where a person accepts it.
        </p>
      </Panel>

      {/* Gated on rows, NOT on done: a run where every document fails still has
          to show its failures. Gating this on done.length meant a totally failed
          run rendered nothing at all and read as "the button does nothing". */}
      {rows.length > 0 && (
        <Panel
          title="Payloads"
          description={`${counts.withName} with a name · ${counts.withChoice} with an explicit consent choice · ${counts.derived} carrying a derived field`}
          actions={
            <div className="flex gap-2">
              <Button variant="secondary" onClick={exportJson} disabled={done.length === 0}>
                JSON
              </Button>
              <Button variant="secondary" onClick={exportCsv} disabled={done.length === 0}>
                CSV
              </Button>
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-4 font-medium">Document</th>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">Phone</th>
                  <th className="py-2 pr-4 font-medium">Consent choice</th>
                  <th className="py-2 font-medium">Pages</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr
                    key={`${row.file}-${i}`}
                    onClick={() => row.payload && setSelected(i)}
                    className={`border-b border-line last:border-0 ${
                      row.payload ? "cursor-pointer hover:bg-canvas" : ""
                    } ${selected === i ? "bg-canvas" : ""}`}
                  >
                    <td className="max-w-xs truncate py-2 pr-4 text-ink" title={row.file}>
                      {row.file}
                    </td>
                    {row.status === "done" && row.payload ? (
                      <>
                        <Cell field={row.payload.name} />
                        <Cell field={row.payload.email} />
                        <Cell field={row.payload.phone} />
                        <Cell field={row.payload.consentChoice} />
                        <td className="py-2 text-muted">{row.pages}</td>
                      </>
                    ) : (
                      <td colSpan={5} className="py-2 text-muted">
                        {row.status === "failed" ? (
                          <span className="text-red">failed — {row.detail}</span>
                        ) : (
                          row.status
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {selected !== null && rows[selected]?.payload && (
        <Panel
          title={rows[selected].file}
          description="Every field carries how it was obtained. A derived value must never read as a stated one."
        >
          <dl className="flex flex-col gap-3">
            {FIELD_ORDER.map(({ key, label, rule }) => {
              const field = rows[selected]!.payload![key] as PayloadField<unknown>;
              return (
                <div key={key} className="border-b border-line pb-3 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <dt className="text-sm font-medium text-ink">{label}</dt>
                    <Badge tone={PROVENANCE_TONE[field.provenance]}>
                      {field.provenance}
                      {field.provenance !== "absent" &&
                        ` · ${Math.round(field.confidence * 100)}%`}
                    </Badge>
                  </div>
                  <dd className="mt-1 break-words text-sm text-ink">{show(field.value)}</dd>
                  <p className="mt-1 text-xs text-muted">
                    {field.source ? <>Source: {field.source}. </> : null}
                    {rule}.
                    {field.page !== null && <> Page {field.page}.</>}
                  </p>
                </div>
              );
            })}
          </dl>
        </Panel>
      )}
    </div>
  );
}

function Cell({ field }: { field: PayloadField<unknown> }) {
  return (
    <td className="py-2 pr-4">
      {field.value === null ? (
        <span className="text-muted">—</span>
      ) : (
        <span className={field.provenance === "derived" ? "text-amber" : "text-ink"}>
          {show(field.value)}
        </span>
      )}
    </td>
  );
}

function download(filename: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
