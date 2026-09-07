"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, FileWarning, Info, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Callout } from "@/components/ui/callout";
import { Panel } from "@/components/ui/panel";
import type { NoticeSummary, Purpose } from "@/lib/catalogue";
import type { DraftPayload } from "@/lib/intake";
import type { ValidationIssue } from "@/lib/consent";
import {
  DATE_PRECISIONS,
  datePrecisionLabels,
  NOTICE_AT_COLLECTION,
  noticeAtCollectionLabels,
  PREFILL_MIN_CONFIDENCE,
  type ExtractedField,
  type Extraction,
  type OcrTokens,
  type TickBoxReading,
} from "@/lib/consent";

/**
 * What the scan said about a field, shown under it.
 *
 * A pre-filled box with no provenance is the exact failure this codebase keeps
 * warning about: reviewers stop checking things that are usually right. So
 * every value that came off the scan says so, and every value the service read
 * but did NOT fill in says that too - a low-confidence read is evidence the
 * reviewer should look at the paper, not something to hide.
 *
 * Declared at module scope rather than inside the form: a component created
 * during render is a new component type on every keystroke, and React would
 * remount it each time.
 */
function ScanHint({ field }: { field: ExtractedField | undefined }) {
  if (!field) return null;
  if (field.value === null) {
    return <span className="text-xs text-amber">Not found on the scan. Read it yourself.</span>;
  }
  if (field.confidence < PREFILL_MIN_CONFIDENCE) {
    return (
      <span className="text-xs text-amber">
        Scan read &ldquo;{field.value}&rdquo; but is not sure. Not filled in — check the paper.
      </span>
    );
  }
  return (
    <span className="text-xs text-muted">
      Read from the scan{field.method === "anchored" ? " beside its printed label" : ""}. Check it.
    </span>
  );
}

interface DuplicateCandidate {
  principalId: string;
  fullName: string;
  reason: string;
}

interface EvidenceRef {
  id: string;
  filename: string;
  contentType: string;
}

/**
 * The single editing surface for a consent form.
 *
 * The manual entry screen and the review screen are the same component on
 * purpose: every intake mode ends at one human confirming what the paper said,
 * so there is one form to get right rather than four that drift apart.
 */
export function DraftForm({
  purposes,
  notices,
  draftId,
  initialPayload,
  initialEvidence,
  initialValidation,
}: {
  purposes: Purpose[];
  notices: NoticeSummary[];
  draftId?: string;
  initialPayload: DraftPayload;
  initialEvidence?: EvidenceRef | null;
  initialValidation?: ValidationIssue[];
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [payload, setPayload] = useState<DraftPayload>(initialPayload);
  const [evidence, setEvidence] = useState<EvidenceRef | null>(initialEvidence ?? null);
  const [issues, setIssues] = useState<ValidationIssue[]>(initialValidation ?? []);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Extraction output, carried from upload through to draft creation so the
  // pair (tokens, human-verified payload) lands on one row. That pair is the
  // training set for text extraction, which is the reason to run OCR now rather
  // than when the model exists: a scan reviewed without it is a label lost.
  const [ocrTokens, setOcrTokens] = useState<OcrTokens | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [extracting, setExtracting] = useState(false);

  const purposeById = useMemo(
    () => new Map(purposes.map((p) => [p.id, p])),
    [purposes],
  );

  const errorFor = (field: string) =>
    issues.find((i) => i.field === field && i.severity === "error")?.message;

  const warnings = issues.filter((i) => i.severity === "warning");
  const errors = issues.filter((i) => i.severity === "error");

  const set = <K extends keyof DraftPayload>(key: K, value: DraftPayload[K]) =>
    setPayload((p) => ({ ...p, [key]: value }));

  /**
   * Choosing the form version replaces the tick-box list with the wording that
   * was actually printed on that version, preserving anything already ticked.
   */
  function selectNotice(noticeId: string) {
    const chosen = notices.find((n) => n.id === noticeId) ?? null;
    // The tick-box labels are the anchor the service matches against, so the
    // scan can only be read once the reviewer says which form version it is.
    if (chosen && evidence) void runExtraction(evidence.id, chosen.id);
    setPayload((p) => {
      const previous = new Map(p.items.map((i) => [i.purposeId, i.granted]));
      return {
        ...p,
        noticeId: chosen?.id ?? null,
        items: chosen
          ? chosen.purposes.map((np) => ({
              purposeId: np.purpose_id,
              granted: previous.get(np.purpose_id) ?? false,
              verbatimLabel: np.printed_label,
            }))
          : p.items,
      };
    });
  }

  const readingFor = (purposeId: string): TickBoxReading | undefined =>
    extraction?.tickboxes.find((t) => t.purposeId === purposeId);

  const fieldFor = (key: ExtractedField["key"]) =>
    extraction?.fields?.find((f) => f.key === key);

  /**
   * The scanned date as YYYY-MM-DD, or null.
   *
   * The scan gives free text ("4 March 2019") and the control is type="date",
   * so an unparseable read must NOT pre-fill - it is shown as a hint instead
   * and the reviewer types it. Refusing to guess here is the same rule the
   * tick-boxes follow: a wrong pre-fill is worse than an empty field.
   */
  const scannedDate = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const parsed = Date.parse(raw.replace(/[^\w\s\-/.]/g, " ").replace(/\s+/g, " ").trim());
    if (Number.isNaN(parsed)) return null;
    const d = new Date(parsed);
    // A date in the future is a misread, not a paper date.
    if (d.getTime() > Date.now()) return null;
    return d.toISOString().slice(0, 10);
  };

  /**
   * Runs the scan through the extraction service.
   *
   * Never blocks and never reports failure: if the service is unavailable the
   * reviewer simply gets the manual entry form, which is this same screen.
   * Tokens are banked whether or not a form version has been chosen, because
   * the corpus does not depend on anyone having configured one yet.
   */
  async function runExtraction(evidenceId: string, noticeId: string | null) {
    setExtracting(true);
    try {
      const response = await fetch("/api/staff/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evidenceId, noticeId }),
      });
      if (!response.ok) return;
      const body = await response.json();
      if (!body.available) return;

      setOcrTokens(body.ocrTokens ?? null);
      setExtraction(body.extraction ?? null);

      const readings: TickBoxReading[] = body.extraction?.tickboxes ?? [];
      if (readings.length === 0) return;

      // Only confident readings pre-fill. A box the service could not locate
      // (granted === null) is left exactly as it was: "not found" is not
      // "not ticked", and a wrong pre-fill is worse than an empty one because
      // reviewers stop checking things that are usually right.
      // The handwritten fields, on the same terms as the tick-boxes: only a
      // confident read, and NEVER over something a person already typed. The
      // reviewer's own keystrokes outrank anything a model proposed, and a
      // scan that lands after they have started typing must not undo it.
      const fields: ExtractedField[] = body.extraction?.fields ?? [];
      const confident = (key: ExtractedField["key"]): string | null => {
        const f = fields.find((x) => x.key === key);
        if (!f || f.value === null || f.confidence < PREFILL_MIN_CONFIDENCE) return null;
        return f.value;
      };

      setPayload((p) => {
        const name = confident("fullName");
        const phone = confident("phone");
        const email = confident("email");
        const dated = scannedDate(confident("collectedOn"));
        return {
          ...p,
          principal: {
            ...p.principal,
            fullName: p.principal.fullName.trim() === "" && name ? name : p.principal.fullName,
            phone: p.principal.phone ? p.principal.phone : phone,
            email: p.principal.email ? p.principal.email : email,
          },
          collectedOn: p.collectedOn ? p.collectedOn : dated,
          collectedOnPrecision:
            p.collectedOn === null && dated ? "day" : p.collectedOnPrecision,
        };
      });

      setPayload((p) => ({
        ...p,
        items: p.items.map((item) => {
          const reading = readings.find((r) => r.purposeId === item.purposeId);
          if (
            reading === undefined ||
            reading.granted === null ||
            reading.confidence < PREFILL_MIN_CONFIDENCE
          ) {
            return item;
          }
          return { ...item, granted: reading.granted };
        }),
      }));
    } catch {
      // Same degradation path as an unavailable service.
    } finally {
      setExtracting(false);
    }
  }

  function toggleItem(purposeId: string, granted: boolean) {
    setPayload((p) => ({
      ...p,
      items: p.items.map((i) => (i.purposeId === purposeId ? { ...i, granted } : i)),
    }));
  }

  async function uploadScan(file: File) {
    setBusy(true);
    setBanner(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("kind", "scan");
      const response = await fetch("/api/staff/evidence", { method: "POST", body });
      const json = await response.json();
      if (!response.ok) {
        setBanner(json.error ?? "Upload failed");
        return;
      }
      setEvidence({ id: json.id, filename: json.filename, contentType: json.contentType });
      // Tokens now, whether or not a form version has been chosen yet.
      void runExtraction(json.id, payload.noticeId);
    } finally {
      setBusy(false);
    }
  }

  /** Creates the draft if it does not exist yet, then commits it. */
  async function save(confirmPrincipalId: string | null, forceNew = false) {
    setBusy(true);
    setBanner(null);
    setDuplicates([]);
    try {
      let id = draftId;

      if (!id) {
        const created = await fetch("/api/staff/drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: evidence ? "scan" : "manual",
            payload,
            evidenceId: evidence?.id ?? null,
            ocrTokens,
            extraction,
          }),
        });
        const body = await created.json();
        if (!created.ok) {
          setIssues(body.fields ? [] : issues);
          setBanner(body.error ?? "Could not save the draft");
          return;
        }
        id = body.id as string;
        setIssues(body.validation ?? []);
        if ((body.validation ?? []).some((i: ValidationIssue) => i.severity === "error")) {
          setBanner("Fix the errors below before committing.");
          return;
        }
      } else {
        const patched = await fetch(`/api/staff/drafts/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload, evidenceId: evidence?.id ?? null }),
        });
        const body = await patched.json();
        if (!patched.ok) {
          setBanner(body.error ?? "Could not save the draft");
          return;
        }
        setIssues(body.validation ?? []);
        if ((body.validation ?? []).some((i: ValidationIssue) => i.severity === "error")) {
          setBanner("Fix the errors below before committing.");
          return;
        }
      }

      const committed = await fetch(`/api/staff/drafts/${id}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmPrincipalId, forceNew }),
      });
      const result = await committed.json();

      if (!committed.ok) {
        if (result.code === "possible_duplicate") {
          setDuplicates(result.detail ?? []);
          setBanner("This may be someone already in the register. Choose below.");
          return;
        }
        if (result.code === "validation_failed") {
          setIssues(result.detail ?? []);
          setBanner("Fix the errors below before committing.");
          return;
        }
        setBanner(result.error ?? "Could not commit");
        return;
      }

      router.push(`/staff/review?committed=${result.artifactId}`);
      router.refresh();
    } catch {
      setBanner("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-6">
        {banner && (
          <Callout tone="red" live="alert" icon={<AlertTriangle size={16} aria-hidden />}>
            {banner}
          </Callout>
        )}

        {duplicates.length > 0 && (
          <Panel
            title="Is this someone already on file?"
            description="Names this close on the same contact point are usually the same person — but they are never merged automatically."
          >
            <ul className="flex flex-col gap-2">
              {duplicates.map((candidate) => (
                <li
                  key={candidate.principalId}
                  className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
                >
                  <span className="text-sm text-ink">{candidate.fullName}</span>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => save(candidate.principalId)}
                  >
                    This is the same person
                  </Button>
                </li>
              ))}
              <li className="pt-1">
                <Button variant="ghost" disabled={busy} onClick={() => save(null, true)}>
                  None of these — create a new record
                </Button>
              </li>
            </ul>
          </Panel>
        )}

        <Panel title="The person" description="Exactly as written on the form.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                label="Full name"
                htmlFor="fullName"
                error={errorFor("fullName")}
                hint={<ScanHint field={fieldFor("fullName")} />}
                required
              >
                <Input
                  id="fullName"
                  value={payload.principal.fullName}
                  error={Boolean(errorFor("fullName"))}
                  onChange={(e) =>
                    set("principal", { ...payload.principal, fullName: e.target.value })
                  }
                />
              </Field>
            </div>
            <Field
              label="Mobile number"
              htmlFor="phone"
              error={errorFor("phone")}
              hint={
                fieldFor("phone") ? (
                  <ScanHint field={fieldFor("phone")} />
                ) : (
                  "Type it as written. It must resolve to a dialable number."
                )
              }
            >
              <Input
                id="phone"
                inputMode="tel"
                value={payload.principal.phone ?? ""}
                error={Boolean(errorFor("phone"))}
                onChange={(e) =>
                  set("principal", {
                    ...payload.principal,
                    phone: e.target.value || null,
                  })
                }
              />
            </Field>
            <Field
              label="Email"
              htmlFor="email"
              error={errorFor("email")}
              hint={<ScanHint field={fieldFor("email")} />}
            >
              <Input
                id="email"
                type="email"
                value={payload.principal.email ?? ""}
                error={Boolean(errorFor("email"))}
                onChange={(e) =>
                  set("principal", { ...payload.principal, email: e.target.value || null })
                }
              />
            </Field>
          </div>
        </Panel>

        <Panel title="The form" description="Which printed form this is, and when it was signed.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Form version" htmlFor="noticeId">
                <Select
                  id="noticeId"
                  value={payload.noticeId ?? ""}
                  onChange={(e) => selectNotice(e.target.value)}
                >
                  <option value="">Not identified</option>
                  {notices.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.form_label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field
              label="Date signed"
              htmlFor="collectedOn"
              error={errorFor("collectedOn")}
              hint={<ScanHint field={fieldFor("collectedOn")} />}
            >
              <Input
                id="collectedOn"
                type="date"
                value={payload.collectedOn ?? ""}
                error={Boolean(errorFor("collectedOn"))}
                onChange={(e) =>
                  setPayload((p) => ({
                    ...p,
                    collectedOn: e.target.value || null,
                    collectedOnPrecision: e.target.value
                      ? p.collectedOnPrecision === "unknown"
                        ? "day"
                        : p.collectedOnPrecision
                      : "unknown",
                  }))
                }
              />
            </Field>

            <Field label="How exact is that date?" htmlFor="precision">
              <Select
                id="precision"
                value={payload.collectedOnPrecision}
                onChange={(e) =>
                  setPayload((p) => ({
                    ...p,
                    collectedOnPrecision: e.target.value as DraftPayload["collectedOnPrecision"],
                    collectedOn: e.target.value === "unknown" ? null : p.collectedOn,
                  }))
                }
              >
                {DATE_PRECISIONS.map((p) => (
                  <option key={p} value={p}>
                    {datePrecisionLabels[p]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Notice at collection" htmlFor="noticeAt">
              <Select
                id="noticeAt"
                value={payload.noticeAtCollection}
                onChange={(e) =>
                  set("noticeAtCollection", e.target.value as DraftPayload["noticeAtCollection"])
                }
              >
                {NOTICE_AT_COLLECTION.map((n) => (
                  <option key={n} value={n}>
                    {noticeAtCollectionLabels[n]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Where it was collected" htmlFor="location">
              <Input
                id="location"
                value={payload.collectionLocation ?? ""}
                onChange={(e) => set("collectionLocation", e.target.value || null)}
              />
            </Field>
          </div>
        </Panel>

        <Panel
          title="What they agreed to"
          description="Tick exactly what the paper shows. A box you cannot read must be resolved from the scan, not guessed."
        >
          {extracting && (
            <p className="mb-3 text-xs text-muted">Reading the scan…</p>
          )}
          {!extracting && extraction && (
            <div className="mb-3">
              <Callout tone="neutral">
                Read from the scan by {extraction.engine} {extraction.engineVersion}. Every
                box below is a suggestion until you confirm it — what you leave here is what
                gets committed, not what the model proposed.
              </Callout>
            </div>
          )}
          {payload.items.length === 0 ? (
            <p className="text-sm text-muted">
              Choose the form version above to load its tick-boxes.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {payload.items.map((item) => {
                const purpose = purposeById.get(item.purposeId);
                const reading = readingFor(item.purposeId);
                const uncertain =
                  reading !== undefined &&
                  (reading.granted === null || reading.confidence < PREFILL_MIN_CONFIDENCE);
                return (
                  <li key={item.purposeId} className="flex items-start gap-3 py-3">
                    <input
                      id={`item-${item.purposeId}`}
                      type="checkbox"
                      checked={item.granted}
                      onChange={(e) => toggleItem(item.purposeId, e.target.checked)}
                      className="mt-0.5 size-4 accent-[var(--navy)]"
                    />
                    <label htmlFor={`item-${item.purposeId}`} className="flex-1 cursor-pointer">
                      <span className="block text-sm text-ink">{item.verbatimLabel}</span>
                      {purpose && (
                        <span className="block text-xs text-muted">{purpose.name}</span>
                      )}
                      {reading && reading.granted === null && (
                        // "Could not find the label" is not "the box is empty".
                        // Saying so is the difference between the reviewer
                        // checking this line and trusting a silent false.
                        <span className="mt-1 block text-xs text-amber">
                          Could not find this wording on the scan. Read it yourself.
                        </span>
                      )}
                      {reading && reading.granted !== null && uncertain && (
                        <span className="mt-1 block text-xs text-amber">
                          Unsure — looks {reading.granted ? "ticked" : "empty"} (
                          {Math.round(reading.confidence * 100)}%). Check the scan.
                        </span>
                      )}
                      {reading && reading.granted !== null && !uncertain && (
                        <span className="mt-1 block text-xs text-muted">
                          From the scan, {Math.round(reading.confidence * 100)}% confident.
                        </span>
                      )}
                    </label>
                    {/*
                      Same grey as the OCR-confidence note two lines above, so
                      the reviewer confirming ticks against paper had the
                      weakest state affordance in the app. Mirrors STATUS_TONE
                      in the portal: the affirmative state carries the colour.
                    */}
                    <Badge tone={item.granted ? "green" : "neutral"}>
                      {item.granted ? "Agreed" : "Not agreed"}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
          {errorFor("items") && <p className="mt-3 text-xs text-red">{errorFor("items")}</p>}
        </Panel>
      </div>

      <div className="flex flex-col gap-6">
        <Panel title="The scan">
          {evidence ? (
            <div className="flex flex-col gap-3">
              <div className="overflow-hidden rounded-md border border-line bg-canvas">
                {evidence.contentType === "application/pdf" ? (
                  <iframe
                    title="Scanned form"
                    src={`/api/staff/evidence/${evidence.id}?inline=1`}
                    className="h-96 w-full"
                  />
                ) : (
                  // Deliberately not next/image: this is private evidence behind
                  // an authenticated route, and the optimiser would cache it
                  // outside that boundary.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt="Scanned consent form"
                    src={`/api/staff/evidence/${evidence.id}?inline=1`}
                    className="w-full"
                  />
                )}
              </div>
              <p className="truncate text-xs text-muted">{evidence.filename}</p>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">
                Attach the scan so the record can be checked against the paper later.
              </p>
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadScan(file);
                }}
              />
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={15} aria-hidden />
                Choose a file
              </Button>
            </div>
          )}
        </Panel>

        {warnings.length > 0 && (
          <Panel title="Worth noting">
            <ul className="flex flex-col gap-2">
              {warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-amber">
                  <Info size={15} className="mt-0.5 shrink-0" aria-hidden />
                  {w.message}
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <div className="rounded-lg border border-line bg-panel p-5">
          <Button
            className="w-full"
            disabled={busy || errors.length > 0}
            onClick={() => save(null)}
          >
            {busy ? (
              "Working…"
            ) : (
              <>
                <Check size={15} aria-hidden />
                Commit to the register
              </>
            )}
          </Button>
          <p className="mt-3 flex items-start gap-2 text-xs text-muted">
            <FileWarning size={14} className="mt-0.5 shrink-0" aria-hidden />
            Committing creates a permanent record. It cannot be edited afterwards — a
            correction is a new form.
          </p>
        </div>
      </div>
    </div>
  );
}
