import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Search } from "lucide-react";
import { requireStaff } from "@/lib/auth";
import { searchPrincipals } from "@/lib/register";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Register" };

/**
 * FR-14, the search half.
 *
 * DPO only. The (authed) layout gates on any staff role, so the stricter gate
 * lives here - the register is every person's paper and every decision taken
 * about it, which is more than an operator needs to do their job.
 *
 * The query is in the URL rather than component state so a DPO can link a
 * colleague to a result, and so a back button behaves.
 */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  try {
    await requireStaff("dpo");
  } catch {
    redirect("/staff");
  }

  const { q = "" } = await searchParams;
  const results = q.trim().length >= 2 ? await searchPrincipals(q) : [];
  const searched = q.trim().length >= 2;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Register</h1>
        <p className="mt-1 text-sm text-muted">
          Find a person to see the paper they signed, their consent now, and everything
          that has happened to their record.
        </p>
      </div>

      <Panel>
        <form method="GET" className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="q" className="sr-only">
            Name, mobile number or email
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q}
            placeholder="Name, mobile number or email"
            className="min-h-11 w-full rounded-md border border-line bg-panel px-3 py-2 text-base text-ink placeholder:text-muted"
          />
          <button
            type="submit"
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-navy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ink"
          >
            <Search size={15} aria-hidden />
            Search
          </button>
        </form>
        <p className="mt-2 text-xs text-muted">
          A number can be typed as it appears on the form. Looking at a record is
          recorded in that person&apos;s audit trail.
        </p>
      </Panel>

      {searched && results.length === 0 && (
        <p className="rounded-md bg-canvas px-3 py-2 text-sm text-muted">
          Nobody in the register matches “{q}”. Try a shorter name, or the other contact
          point.
        </p>
      )}

      {results.length > 0 && (
        <ul className="flex flex-col gap-2">
          {results.map((person) => (
            <li key={person.id}>
              <Link
                href={`/staff/principals/${person.id}`}
                className="flex items-start gap-3 rounded-lg border border-line bg-panel p-4 hover:border-navy"
              >
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">
                    {person.full_name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {[person.phone_e164, person.email].filter(Boolean).join(" · ") ||
                      "No contact point"}
                  </span>
                  <span className="mt-1 block text-xs text-muted">
                    {person.artifacts} form{person.artifacts === 1 ? "" : "s"} on file
                  </span>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {person.merged_into_id && <Badge tone="amber">Merged</Badge>}
                  {person.active_consents > 0 && (
                    <Badge tone="green">{person.active_consents} active</Badge>
                  )}
                  {person.withdrawn_consents > 0 && (
                    <Badge>{person.withdrawn_consents} withdrawn</Badge>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
