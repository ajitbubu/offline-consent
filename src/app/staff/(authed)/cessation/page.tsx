import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { requireStaff } from "@/lib/auth";
import { loadTasks } from "@/lib/cessation";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { QueueAction } from "@/components/queue-action";

export const metadata: Metadata = { title: "Stop processing" };

const when = (d: Date) =>
  d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/**
 * FR-13: the s.6(6) queue.
 *
 * Withdrawal changed our own row and stopped there, which made the obligation
 * unverifiable - nothing said which systems hold this person's data or whether
 * any of them were told. Each withdrawal now raises a task per active system,
 * and this is where they get worked.
 */
export default async function CessationPage({
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
  const view = status === "on_hold" || status === "completed" ? status : "open";
  const tasks = await loadTasks(view);

  const TABS = [
    ["open", "To do"],
    ["on_hold", "Held under the Act"],
    ["completed", "Done"],
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Stop processing</h1>
        <p className="mt-1 text-sm text-muted">
          s.6(6) requires causing the systems that hold this person&apos;s data to stop, not
          only changing our own record. One task per withdrawal per system.
        </p>
      </div>

      <nav className="flex gap-1 border-b border-line" aria-label="Task status">
        {TABS.map(([value, label]) => (
          <Link
            key={value}
            href={`/staff/cessation?status=${value}`}
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

      {tasks.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted">
            {view === "open"
              ? "Nothing outstanding. Every withdrawal has been carried through to the systems that hold the data."
              : "Nothing here."}
          </p>
        </Panel>
      ) : (
        <ul className="flex flex-col gap-2">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-start"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/staff/principals/${t.data_principal_id}`}
                    className="text-sm font-medium text-ink hover:text-blue"
                  >
                    {t.principal_name}
                  </Link>
                  <Badge tone={t.overdue ? "red" : "neutral"}>
                    {t.status === "open" ? (t.overdue ? "Overdue" : `Due ${when(t.due_at)}`) : null}
                    {t.status === "on_hold" ? "Held" : null}
                    {t.status === "completed" ? "Done" : null}
                  </Badge>
                  {t.overdue && (
                    <AlertTriangle size={14} className="text-red" aria-hidden />
                  )}
                </div>
                <p className="mt-0.5 text-sm text-muted">
                  Stop <strong className="font-medium text-ink">{t.purpose_name}</strong> in{" "}
                  <strong className="font-medium text-ink">{t.system_name}</strong>
                </p>
                <p className="mt-1 text-xs text-muted">
                  Owner {t.system_owner} · raised {when(t.raised_at)}
                </p>
                {t.hold_reason && (
                  <p className="mt-1 rounded-md bg-amber-soft px-2 py-1 text-xs text-amber">
                    {/* s.6(6) permits continued processing only where the Act
                        requires it, so this is a legal claim. The database makes
                        the person mandatory; showing them is the other half. */}
                    Held by {t.decided_by ?? "an unknown staff member"}: {t.hold_reason}
                  </p>
                )}
                {t.status === "completed" && (
                  <p className="mt-1 text-xs text-muted">
                    Stopped by {t.decided_by ?? "an unknown staff member"}
                    {t.decided_at ? ` on ${when(t.decided_at)}` : ""}
                    {t.completion_note ? ` — ${t.completion_note}` : ""}
                  </p>
                )}
              </div>

              {view === "open" && (
                <div className="flex flex-col gap-2 sm:w-80">
                  <QueueAction
                    endpoint={`/api/staff/cessation/${t.id}`}
                    body={{ action: "complete" }}
                    label="Mark stopped"
                    placeholder="Suppression list updated and confirmed by the owner"
                    minNote={4}
                  />
                  <QueueAction
                    endpoint={`/api/staff/cessation/${t.id}`}
                    body={{ action: "hold" }}
                    label="Hold under the Act"
                    placeholder="Retained under s.8(7) for statutory tax records"
                    minNote={8}
                    variant="secondary"
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
