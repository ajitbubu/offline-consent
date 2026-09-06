import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { confidenceOf, findDuplicates } from "@/lib/duplicates";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Possible duplicates" };

/**
 * The other half of merge.
 *
 * Merge existed and nothing said what to merge, which made it a tool for a
 * problem nobody could see. This is a report and nothing more: it never merges,
 * never ranks a household as a duplicate, and sends the DPO to the record rather
 * than offering a one-click fix, because fusing two real people is the mistake
 * Invariant 11 exists to prevent and nothing can undo it.
 */
export default async function DuplicatesPage() {
  try {
    await requireStaff("dpo");
  } catch {
    redirect("/staff");
  }

  const pairs = await findDuplicates();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Possible duplicates</h1>
        <p className="mt-1 text-sm text-muted">
          Identity is a contact point plus a name, so one person becomes two records when
          one form carried a phone and another an email, or when a name was transcribed
          differently. The portal only ever resolves one contact point, so the second
          record&apos;s consents cannot be withdrawn by anybody.
        </p>
      </div>

      <Callout tone="neutral">
        Nothing here is merged automatically, and a shared phone number is not on this list
        on its own — households share numbers, and merging two real people is the one thing
        that cannot be undone. Open both records and check the paper.
      </Callout>

      {pairs.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted">
            No candidates. Either the register is clean or everything found has already been
            merged.
          </p>
        </Panel>
      ) : (
        <ul className="flex flex-col gap-2">
          {pairs.map((pair) => {
            const confidence = confidenceOf(pair);
            return (
              <li
                key={`${pair.a_id}-${pair.b_id}`}
                className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={confidence.tone}>{confidence.label}</Badge>
                  <span className="text-xs text-muted">
                    names {Math.round(pair.similarity * 100)}% alike
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { id: pair.a_id, name: pair.a_name, contact: pair.a_contact, n: pair.a_artifacts },
                    { id: pair.b_id, name: pair.b_name, contact: pair.b_contact, n: pair.b_artifacts },
                  ].map((side) => (
                    <Link
                      key={side.id}
                      href={`/staff/principals/${side.id}`}
                      className="rounded-md border border-line p-3 hover:border-navy"
                    >
                      <span className="block text-sm font-medium text-ink">{side.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {side.contact ?? "No contact point"}
                      </span>
                      <span className="mt-1 block text-xs text-muted">
                        {side.n} form{side.n === 1 ? "" : "s"} on file
                      </span>
                    </Link>
                  ))}
                </div>

                <p className="text-xs text-muted">{confidence.note}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
