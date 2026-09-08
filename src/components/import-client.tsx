"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import type { ValidationIssue } from "@/lib/consent";

interface Purpose { id: string; code: string; name: string }
interface Notice { id: string; label: string }
interface RowReport { rowNumber: number; issues: ValidationIssue[] }

const FIELDS = [
  { key: "full_name", label: "Full name", required: true },
  { key: "phone", label: "Mobile number", required: false },
  { key: "email", label: "Email", required: false },
  { key: "collected_on", label: "Date signed (YYYY-MM-DD)", required: false },
  { key: "collection_location", label: "Where it was collected", required: false },
];

/**
 * Upload, map, read the report, commit.
 *
 * The report step is not a formality. Every row becomes a draft whether it is
 * clean or not, so this is where an operator finds out that column F was not a
 * yes-or-no and that eleven dates were written the American way - before any of
 * it becomes evidence.
 */
export function ImportClient({ purposes, notices }: { purposes: Purpose[]; notices: Notice[] }) {
  const [stage, setStage] = useState<"upload" | "map" | "report">("upload");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [noticeId, setNoticeId] = useState<string>("");
  const [report, setReport] = useState<RowReport[]>([]);
  const [clean, setClean] = useState(0);
  const [committed, setCommitted] = useState<{ committed: number; held: number; skipped: { rowNumber: number; reason: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch("/api/staff/batches", { method: "POST", body });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Could not read that file");
        return;
      }
      setBatchId(payload.batchId);
      setHeaders(payload.headers);
      setRowCount(payload.rowCount);
      setStage("map");
    } finally {
      setBusy(false);
    }
  }

  async function applyMapping() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/staff/batches/${batchId}/map`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
          noticeId: noticeId || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Could not map that file");
        return;
      }
      setReport(payload.report);
      setClean(payload.clean);
      setStage("report");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/staff/batches/${batchId}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Could not commit the batch");
        return;
      }
      setCommitted(payload);
    } finally {
      setBusy(false);
    }
  }

  const setField = (key: string, header: string) =>
    setMapping((m) => ({ ...m, [key]: header }));

  const headerOptions = (
    <>
      <option value="">Not in this file</option>
      {headers.map((h) => (
        <option key={h} value={h}>{h}</option>
      ))}
    </>
  );

  if (committed) {
    return (
      <Panel title="Import finished">
        <p className="flex items-center gap-2 text-sm text-ink">
          <CheckCircle2 size={16} className="text-green" aria-hidden />
          {committed.committed} row{committed.committed === 1 ? "" : "s"} committed to the register.
        </p>
        {committed.held > 0 && (
          <p className="mt-3 text-sm text-ink">
            {committed.held} row{committed.held === 1 ? "" : "s"} were not attempted, because the
            report said they need a person. They are waiting in the{" "}
            <Link href="/staff/review" className="text-blue hover:underline">review queue</Link>{" "}
            with what the spreadsheet actually said. Nothing was guessed on your behalf.
          </p>
        )}
        {committed.skipped.length > 0 && (
          <>
            <p className="mt-3 text-sm text-ink">
              {committed.skipped.length} row{committed.skipped.length === 1 ? "" : "s"} were tried
              and could not commit — usually a possible duplicate, which only a person may
              resolve.
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {committed.skipped.slice(0, 50).map((s) => (
                <li key={s.rowNumber} className="text-xs text-muted">
                  Row {s.rowNumber}: {s.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Callout tone="red" live="alert">{error}</Callout>
      )}

      {stage === "upload" && (
        <Panel title="Choose the spreadsheet" description="CSV only. It is kept as evidence, like a scan.">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-canvas">
            <Upload size={15} aria-hidden />
            {busy ? "Reading…" : "Choose a CSV"}
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
        </Panel>
      )}

      {stage === "map" && (
        <Panel
          title={`Map the columns (${rowCount} rows)`}
          description="Say which column holds what. Anything left unmapped is simply not imported."
        >
          <div className="flex flex-col gap-3">
            <Field label="Which printed form were these signed on?" htmlFor="notice">
              <Select id="notice" value={noticeId} onChange={(e) => setNoticeId(e.target.value)}>
                <option value="">Not identified</option>
                {notices.map((n) => (
                  <option key={n.id} value={n.id}>{n.label}</option>
                ))}
              </Select>
            </Field>

            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`m-${f.key}`} required={f.required}>
                <Select id={`m-${f.key}`} value={mapping[f.key] ?? ""} onChange={(e) => setField(f.key, e.target.value)}>
                  {headerOptions}
                </Select>
              </Field>
            ))}

            <p className="mt-2 text-sm font-medium text-ink">Tick-box columns</p>
            {purposes.map((p) => (
              <Field key={p.id} label={p.name} htmlFor={`m-p-${p.code}`}>
                <Select
                  id={`m-p-${p.code}`}
                  value={mapping[`purpose:${p.code}`] ?? ""}
                  onChange={(e) => setField(`purpose:${p.code}`, e.target.value)}
                >
                  {headerOptions}
                </Select>
              </Field>
            ))}

            <Button onClick={applyMapping} disabled={busy || !mapping.full_name}>
              {busy ? "Reading rows…" : "Check the rows"}
            </Button>
          </div>
        </Panel>
      )}

      {stage === "report" && (
        <Panel
          title="Row report"
          description={`${clean} of ${report.length} rows are ready. The rest need a person.`}
          actions={
            <Button onClick={commit} disabled={busy || clean === 0}>
              {busy ? "Committing…" : `Commit ${clean} rows`}
            </Button>
          }
        >
          <ul className="flex flex-col divide-y divide-line">
            {report.map((row) => {
              const errors = row.issues.filter((i) => i.severity === "error");
              const warnings = row.issues.filter((i) => i.severity === "warning");
              return (
                <li key={row.rowNumber} className="flex items-start gap-3 py-2 first:pt-0">
                  <span className="w-14 shrink-0 text-xs text-muted">Row {row.rowNumber}</span>
                  <div className="min-w-0 flex-1">
                    {errors.length === 0 ? (
                      <span className="text-xs text-muted">
                        Ready{warnings.length > 0 ? ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}
                      </span>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {errors.map((e, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs text-red">
                            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
                            {e.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <Badge tone={errors.length === 0 ? "green" : "red"}>
                    {errors.length === 0 ? "Ready" : "Needs a person"}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </div>
  );
}
