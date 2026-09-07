import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { requireStaff } from "@/lib/auth";
import { loadLookupRequests } from "@/lib/lookup";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Panel } from "@/components/ui/panel";
import { LookupResolve } from "@/components/lookup-resolve";
import { QueueAction } from "@/components/queue-action";

export const metadata: Metadata = { title: "Can't find their record" };

const when = (d: Date) =>
  d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/**
 * The queue behind the portal's escape hatch.
 *
 * Everyone in this list has told us they cannot reach their own record. If the
 * transcription on their form was wrong, this page is the only remaining way
 * they will ever exercise s.6(4) - so a request sitting here untouched is not a
 * backlog item, it is a statutory right currently not working for a named
 * person. That is why the wait is shown in days and why anything over a week is
 * flagged rather than merely sorted to the top.
 */
export default async function LookupRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  try {
    await requireStaff("dpo");
  } catch {
    redirect("/staff");
  }

  const { status } = await searchParams;
  const view = status === "resolved" || status === "rejected" ? status : "open";
  const requests = await loadLookupRequests(view);

  const TABS = [
    ["open", "Waiting"],
    ["resolved", "Found"],
    ["rejected", "Not found"],
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Can&apos;t find their record</h1>
        <p className="mt-1 text-sm text-muted">
          People who could not reach their own record through the portal. If the number or
          email on their form was mistyped, this is the only route they have left.
        </p>
      </div>

      <nav className="flex gap-1 border-b border-line" aria-label="Request status">
        {TABS.map(([value, label]) => (
          <Link
            key={value}
            href={`/staff/lookup-requests?status=${value}`}
            aria-current={view === value ? "page" : undefined}
            className={`border-b-2 px-3 py-2 text-sm ${
              view === value
                ? "border-navy font-medium text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {requests.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted">
            {view === "open"
              ? "Nobody is waiting. Everyone who asked for help has been answered."
              : "Nothing here."}
          </p>
        </Panel>
      ) : (
        <ul className="flex flex-col gap-2">
          {requests.map((r) => {
            const stale = r.status === "open" && r.waiting_days >= 7;
            return (
              <li
                key={r.id}
                className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-start"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{r.claimed_name}</span>
                    {r.status === "open" && (
                      <Badge tone={stale ? "red" : "neutral"}>
                        {r.waiting_days === 0
                          ? "Today"
                          : `Waiting ${r.waiting_days} day${r.waiting_days === 1 ? "" : "s"}`}
                      </Badge>
                    )}
                    {stale && <AlertTriangle size={14} className="text-red" aria-hidden />}
                  </div>

                  {/* The note is the only evidence of who this person is, so it
                      is shown whole rather than truncated. It is also untrusted
                      free text from an unauthenticated caller - rendered as
                      text, never as markup. */}
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted">
                    {r.contact_note}
                  </p>

                  <p className="mt-1 text-xs text-muted">
                    Filed {when(r.created_at)}
                    {r.form_reference ? ` · form reference ${r.form_reference}` : ""}
                  </p>

                  {r.status === "resolved" && (
                    <p className="mt-1 text-xs text-muted">
                      Matched to{" "}
                      {r.resolved_principal_id ? (
                        <Link
                          href={`/staff/principals/${r.resolved_principal_id}`}
                          className="text-blue hover:underline"
                        >
                          {r.resolved_principal_name ?? "a record"}
                        </Link>
                      ) : (
                        "a record"
                      )}{" "}
                      by {r.handled_by_name ?? "an unknown staff member"}
                      {r.handled_at ? ` on ${when(r.handled_at)}` : ""}
                    </p>
                  )}

                  {r.status === "rejected" && (
                    <p className="mt-1 text-xs text-muted">
                      Closed by {r.handled_by_name ?? "an unknown staff member"}
                      {r.handled_at ? ` on ${when(r.handled_at)}` : ""}
                    </p>
                  )}
                </div>

                {view === "open" && (
                  <div className="flex flex-col gap-2 sm:w-96">
                    <LookupResolve requestId={r.id} claimedName={r.claimed_name} />
                    <QueueAction
                      endpoint={`/api/staff/lookup-requests/${r.id}`}
                      body={{ action: "reject" }}
                      label="No record found"
                      placeholder="Searched name, both numbers and the form reference — nothing on file"
                      minNote={8}
                      variant="secondary"
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {view === "open" && requests.length > 0 && (
        <Callout tone="blue">
          Closing one of these as &ldquo;no record found&rdquo; does not mean the person is
          not in the register — it means the details they gave did not match anything. If
          these are rising, the transcription step upstream is where to look.
        </Callout>
      )}
    </div>
  );
}
