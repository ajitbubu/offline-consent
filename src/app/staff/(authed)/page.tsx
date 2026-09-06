import Link from "next/link";
import type { Metadata } from "next";
import { query } from "@/lib/db";
import { requireStaff } from "@/lib/auth";
import { Callout } from "@/components/ui/callout";
import { Panel } from "@/components/ui/panel";
import { roleAtLeast } from "@/lib/consent";
import { corpusStatus } from "@/lib/training";

export const metadata: Metadata = { title: "Overview" };

interface Counts {
  drafts_pending: string;
  committed_today: string;
  withdrawals_7d: string;
  notices_owed: string;
  undated_forms: string;
}

async function loadCounts(): Promise<Counts> {
  const { rows } = await query<Counts>(`
    SELECT
      (SELECT count(*) FROM intake_draft WHERE status = 'needs_review') AS drafts_pending,
      (SELECT count(*) FROM consent_artifact
         WHERE committed_at >= date_trunc('day', now()))              AS committed_today,
      (SELECT count(*) FROM consent_record
         WHERE status = 'withdrawn'
           AND withdrawn_at > now() - interval '7 days')              AS withdrawals_7d,
      -- DPDP s.5(2): personal data held from before commencement still needs a
      -- notice. A form digitised with no notice attached is what creates that
      -- obligation, so this is the headline compliance number.
      (SELECT count(*) FROM consent_artifact
         WHERE notice_at_collection IN ('none', 'unknown'))           AS notices_owed,
      (SELECT count(*) FROM consent_artifact
         WHERE collected_on_precision = 'unknown')                    AS undated_forms
  `);
  return rows[0];
}

function Stat({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-3xl font-semibold tabular text-ink">{value}</dd>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </>
  );
  return (
    <div className="rounded-lg border border-line bg-panel px-5 py-4">
      {href ? (
        <Link href={href} className="block hover:opacity-80">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}

export default async function StaffOverviewPage() {
  const staff = await requireStaff();
  const [counts, corpus] = await Promise.all([loadCounts(), corpusStatus()]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold text-ink">Overview</h1>
        <p className="mt-1 text-sm text-muted">
          Paper consent digitised into the register, and what it obliges us to do next.
        </p>
      </div>

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Awaiting review"
          value={counts.drafts_pending}
          hint="Drafts not yet committed"
          href="/staff/review"
        />
        <Stat label="Committed today" value={counts.committed_today} hint="Consent artifacts" />
        <Stat
          label="Withdrawn this week"
          value={counts.withdrawals_7d}
          hint="Via the portal or staff"
        />
        <Stat
          label="Notices owed"
          value={counts.notices_owed}
          hint="s.5(2) — no notice at collection"
          href={roleAtLeast(staff.role, "dpo") ? "/staff/notices" : undefined}
        />
      </dl>

      <Panel
        title="Getting started"
        description="Every intake route ends at the same review step, and nothing enters the register without a person approving it."
      >
        <ol className="flex flex-col gap-3 text-sm text-ink">
          <li>
            <Link href="/staff/intake/new" className="font-medium text-blue hover:underline">
              Digitise a paper form
            </Link>
            <span className="text-muted"> — attach the scan, transcribe the fields.</span>
          </li>
          <li>
            <Link href="/staff/review" className="font-medium text-blue hover:underline">
              Work the review queue
            </Link>
            <span className="text-muted">
              {" "}
              — {counts.drafts_pending} draft{counts.drafts_pending === "1" ? "" : "s"} waiting.
            </span>
          </li>
          {roleAtLeast(staff.role, "dpo") && (
            <li>
              <Link href="/staff/principals" className="font-medium text-blue hover:underline">
                Search the register
              </Link>
              <span className="text-muted"> — artifacts, current consent, audit trail.</span>
            </li>
          )}
          {/* Occasional jobs rather than daily navigation, so they live here
              instead of taking a slot in the primary nav. */}
          {roleAtLeast(staff.role, "dpo") && (
            <li>
              <Link href="/staff/import" className="font-medium text-blue hover:underline">
                Import a spreadsheet
              </Link>
              <span className="text-muted">
                {" "}
                — a CSV of records already typed out of the filing cabinet.
              </span>
            </li>
          )}
          <li>
            <Link href="/staff/kiosk" className="font-medium text-blue hover:underline">
              Set up the counter tablet
            </Link>
            <span className="text-muted"> — capture a signature at the counter.</span>
          </li>
        </ol>
        {roleAtLeast(staff.role, "dpo") && (
          <p className="mt-4 rounded-md bg-canvas px-3 py-2 text-sm text-muted">
            Extraction corpus: <strong className="text-ink">{corpus.pairs}</strong> of{" "}
            {corpus.target} scans needed before a text model is worth training.{" "}
            {corpus.ready
              ? "Enough to try."
              : corpus.missedPairs > 0
                ? `${corpus.missedPairs} committed scan${corpus.missedPairs === 1 ? " carries" : "s carry"} no OCR tokens — ${corpus.missedPairs === 1 ? "that pair is" : "those pairs are"} gone. Set ML_SERVICE_URL so the rest are banked.`
                : "Every scan reviewed without the extraction service running is a pair lost for good."}
          </p>
        )}

        {counts.undated_forms !== "0" && (
          <div className="mt-4">
            {/* No live region: this is standing advice, not something that just
                happened. A page that announces its own boilerplate on every
                visit teaches people to ignore the announcements that matter. */}
            <Callout tone="amber">
              {counts.undated_forms} artifact{counts.undated_forms === "1" ? " is" : "s are"}{" "}
              recorded as undated. An undated consent is a weak consent, so the s.5(2) notice
              matters more for these.
            </Callout>
          </div>
        )}
      </Panel>
    </div>
  );
}
