import Link from "next/link";
import type { Metadata } from "next";
import { CheckCircle2 } from "lucide-react";
import { query } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Panel } from "@/components/ui/panel";
import { intakeSourceLabels, type IntakeSource } from "@/lib/consent";

export const metadata: Metadata = { title: "Review queue" };

interface QueueRow {
  id: string;
  source: IntakeSource;
  created_at: Date;
  full_name: string | null;
  error_count: number;
  warning_count: number;
  has_scan: boolean;
}

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ committed?: string }>;
}) {
  const { committed } = await searchParams;

  const { rows } = await query<QueueRow>(`
    SELECT d.id,
           d.source,
           d.created_at,
           NULLIF(btrim(COALESCE(d.payload->'principal'->>'fullName', '')), '') AS full_name,
           (SELECT count(*) FROM jsonb_array_elements(d.validation) v
             WHERE v->>'severity' = 'error')::int   AS error_count,
           (SELECT count(*) FROM jsonb_array_elements(d.validation) v
             WHERE v->>'severity' = 'warning')::int AS warning_count,
           d.evidence_id IS NOT NULL AS has_scan
      FROM intake_draft d
     WHERE d.status = 'needs_review'
     ORDER BY d.created_at
     LIMIT 200
  `);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Review queue</h1>
        <p className="mt-1 text-sm text-muted">
          Drafts waiting for a person to confirm them against the paper.
        </p>
      </div>

      {committed && (
        <Callout tone="green" live="status" icon={<CheckCircle2 size={16} aria-hidden />}>
          Committed to the register. The artifact is now permanent evidence.
        </Callout>
      )}

      {rows.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted">
            Nothing waiting.{" "}
            <Link href="/staff/intake/new" className="text-blue hover:underline">
              Digitise a form
            </Link>
            .
          </p>
        </Panel>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/staff/review/${row.id}`}
                className="flex items-center gap-4 rounded-lg border border-line bg-panel px-5 py-4 hover:border-muted"
              >
                <span className="flex-1">
                  <span className="block text-sm font-medium text-ink">
                    {row.full_name ?? "Unnamed draft"}
                  </span>
                  <span className="block text-xs text-muted">
                    {intakeSourceLabels[row.source]}
                    {row.has_scan ? " · scan attached" : " · no scan"} ·{" "}
                    {new Date(row.created_at).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                </span>
                {row.error_count > 0 && (
                  <Badge tone="red">
                    {row.error_count} error{row.error_count === 1 ? "" : "s"}
                  </Badge>
                )}
                {row.error_count === 0 && row.warning_count > 0 && (
                  <Badge tone="amber">
                    {row.warning_count} to note
                  </Badge>
                )}
                {row.error_count === 0 && row.warning_count === 0 && (
                  <Badge tone="green">Ready</Badge>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
