import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, FileText, ShieldAlert } from "lucide-react";
import { requireStaff } from "@/lib/auth";
import {
  loadAbsorbed,
  loadArtifacts,
  loadAuditTrail,
  loadConsents,
  loadPrincipal,
  recordPrincipalView,
} from "@/lib/register";
import { Badge, type Tone } from "@/components/ui/badge";
import { MergeForm } from "@/components/merge-form";
import { Panel } from "@/components/ui/panel";
import {
  consentStatusLabels,
  datePrecisionLabels,
  noticeAtCollectionLabels,
  intakeSourceLabels,
  type ConsentStatus,
  type DatePrecision,
} from "@/lib/consent";

export const metadata: Metadata = { title: "Person" };

const STATUS_TONE: Record<ConsentStatus, Tone> = {
  active: "green",
  withdrawn: "neutral",
  declined: "neutral",
};

/** A civil date, in the register's own locale. Paper dates are already strings. */
const day = (value: string | null) =>
  value ? new Date(`${value}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }) : null;

const instant = (value: Date) =>
  value.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

const ACTION_LABELS: Record<string, string> = {
  consent_digitised: "Form digitised",
  consent_withdrawn: "Consent withdrawn",
  withdrawal_reaffirmed: "Withdrawal asked for again",
  draft_created: "Draft created",
  draft_rejected: "Draft rejected",
  extraction_performed: "Scan read by the extraction service",
  evidence_accessed: "Evidence opened",
  evidence_destroyed: "Evidence destroyed",
  otp_issued: "One-time code sent",
  otp_verified: "One-time code accepted",
  otp_failed: "One-time code refused",
  principal_selected: "Person chosen at the portal",
  staff_viewed_principal: "Record viewed by staff",
  principals_merged: "Records merged",
  notice_delivered: "Notice delivered",
  cessation_completed: "Downstream processing stopped",
};

/**
 * FR-14: every artifact, the consent now, and the full audit trail for one
 * person.
 *
 * Viewing writes `staff_viewed_principal`, deduplicated per viewing session by
 * recordPrincipalView. The register is the most sensitive screen in the
 * application - one person's paper and every decision taken about it - so
 * reading it is itself an event worth recording.
 *
 * It is recorded ONCE per session, not once per render. Server components render
 * on prefetch, on Fast Refresh and again on navigation, and audit_log is
 * append-only: the first version of this wrote 115 unremovable rows in twenty
 * minutes and buried everything that mattered.
 */
export default async function PrincipalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  let staff;
  try {
    staff = await requireStaff("dpo");
  } catch {
    redirect("/staff");
  }

  const { id } = await params;
  const person = await loadPrincipal(id);
  if (!person) notFound();

  const [artifacts, consents, trail, absorbed] = await Promise.all([
    loadArtifacts(id),
    loadConsents(id),
    loadAuditTrail(id),
    loadAbsorbed(id),
  ]);

  await recordPrincipalView(id, staff.staffId, {
    artifacts: artifacts.length,
    consents: consents.length,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/staff/principals"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={15} aria-hidden />
          Register
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-ink">{person.full_name}</h1>
        <p className="mt-1 text-sm text-muted">
          {[person.phone_e164, person.email].filter(Boolean).join(" · ") ||
            "No contact point on file"}
          {" · in the register since "}
          {instant(person.created_at)}
        </p>
      </div>

      {person.merged_into_id && (
        <p className="flex items-start gap-2 rounded-md bg-amber-soft px-3 py-2 text-sm text-amber">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            This identity was merged into{" "}
            <Link href={`/staff/principals/${person.merged_into_id}`} className="underline">
              another record
            </Link>
            . Its artifacts stay here, because an artifact records what one piece of paper
            said. The portal resolves through the chain.
          </span>
        </p>
      )}

      {absorbed.length > 0 && (
        <p className="rounded-md bg-canvas px-3 py-2 text-sm text-muted">
          Absorbed {absorbed.length === 1 ? "identity" : "identities"}:{" "}
          {absorbed.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ", "}
              <Link href={`/staff/principals/${a.id}`} className="text-blue hover:underline">
                {a.full_name}
              </Link>
            </span>
          ))}
        </p>
      )}

      {person.merged_into_id === null && (
        <MergeForm absorbedId={person.id} absorbedName={person.full_name} />
      )}

      <Panel
        title="Consent now"
        description="What enforcement reads. This is the mutable half."
      >
        {consents.length === 0 ? (
          <p className="text-sm text-muted">No consent records.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {consents.map((c) => (
              <li key={c.purpose_id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{c.purpose_name}</span>
                  <span className="block text-xs text-muted">
                    {c.status === "withdrawn" && c.withdrawn_at
                      ? `Withdrawn ${instant(c.withdrawn_at)}${c.withdrawal_channel ? ` via ${c.withdrawal_channel}` : ""}`
                      : c.consent_given_on
                        ? `Given on ${day(c.consent_given_on)}`
                        : "No date on the form"}
                    {` · v${c.version}`}
                  </span>
                </div>
                <Badge tone={STATUS_TONE[c.status]}>{consentStatusLabels[c.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title={`Paper on file (${artifacts.length})`}
        description="Immutable. A correction is a new form, never an edit."
      >
        {artifacts.length === 0 ? (
          <p className="text-sm text-muted">No artifacts.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {artifacts.map((a) => (
              <li key={a.id} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <FileText size={15} className="text-muted" aria-hidden />
                  <span className="text-sm font-medium text-ink">
                    {a.form_label ?? "Form version not identified"}
                  </span>
                  {a.notice_code && a.notice_version && (
                    <Link
                      href={`/notice/${a.notice_code}/${a.notice_version}`}
                      className="text-xs text-blue hover:underline"
                    >
                      read the notice
                    </Link>
                  )}
                  {a.has_evidence && <Badge tone="blue">Scan attached</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted">
                  {a.collected_on
                    ? `Signed ${day(a.collected_on)}`
                    : "Undated form"}
                  {` (${datePrecisionLabels[a.collected_on_precision as DatePrecision]})`}
                  {` · ${noticeAtCollectionLabels[a.notice_at_collection]}`}
                  {` · ${intakeSourceLabels[a.intake_mode === "scan_reviewed" ? "scan" : a.intake_mode]}`}
                  {a.transcribed_by_name ? ` · transcribed by ${a.transcribed_by_name}` : ""}
                  {` · digitised ${instant(a.committed_at)}`}
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {a.items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <Badge tone={item.granted ? "green" : "neutral"}>
                        {item.granted ? "Agreed" : "Not agreed"}
                      </Badge>
                      <span className="text-muted">{item.verbatim_label}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 font-mono text-[11px] text-muted">
                  payload {a.payload_hash.slice(0, 16)}…
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title={`Audit trail (${trail.length})`}
        description="Append-only. Newest first."
      >
        {trail.length === 0 ? (
          <p className="text-sm text-muted">Nothing recorded.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {trail.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink">
                    {ACTION_LABELS[entry.action] ?? entry.action}
                  </span>
                  {entry.compliance_tags.map((tag) => (
                    <Badge key={tag} tone="blue">
                      {tag.replace("dpdp_s", "s.").replace("_", "(") + ")"}
                    </Badge>
                  ))}
                </div>
                <span className="text-xs text-muted">
                  {instant(entry.timestamp)}
                  {" · "}
                  {entry.actor_name ?? entry.actor_type.replace("_", " ")}
                  {entry.reason ? ` · ${entry.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
