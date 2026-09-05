import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { loadNoticeQueue } from "@/lib/notices";
import { Panel } from "@/components/ui/panel";
import { QueueAction } from "@/components/queue-action";

export const metadata: Metadata = { title: "Notices owed" };

const day = (v: string | null) =>
  v
    ? new Date(`${v}T00:00:00Z`).toLocaleDateString("en-IN", {
        day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
      })
    : "undated";

/**
 * FR-12: the s.5(2) queue.
 *
 * The dashboard has counted this since day one; nobody could work it. Most
 * pre-2023 paper carries no compliant notice, so digitising honestly turns a
 * dormant obligation into a countable one - that is the intended outcome, and
 * this is where it gets discharged.
 */
export default async function NoticesPage() {
  try {
    await requireStaff("dpo");
  } catch {
    redirect("/staff");
  }

  const queue = await loadNoticeQueue();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Notices owed</h1>
        <p className="mt-1 text-sm text-muted">
          People whose forms recorded no notice at collection, or none we can vouch for.
          Under s.5(2) they are owed one. Not knowing is not evidence that one was given.
        </p>
      </div>

      {queue.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted">
            Nobody is owed a notice. Every form on file either carried one or has been
            followed up.
          </p>
        </Panel>
      ) : (
        <ul className="flex flex-col gap-2">
          {queue.map((row) => (
            <li
              key={row.data_principal_id}
              className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-start"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={`/staff/principals/${row.data_principal_id}`}
                  className="text-sm font-medium text-ink hover:text-blue"
                >
                  {row.full_name}
                </Link>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {[row.phone_e164, row.email].filter(Boolean).join(" · ") ||
                    "No contact point — cannot be reached"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {row.artifacts} form{row.artifacts === 1 ? "" : "s"} · earliest{" "}
                  {day(row.earliest_collected_on)}
                </p>
              </div>
              <div className="sm:w-72">
                <QueueAction
                  endpoint="/api/staff/notices/deliver"
                  body={{ principalId: row.data_principal_id, channel: "post" }}
                  label="Record notice sent"
                  placeholder="Posted to the address on the form, 5 Sept"
                  minNote={4}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
