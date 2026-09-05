import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { query } from "@/lib/db";
import { DraftForm } from "@/components/draft-form";
import { loadNotices, loadPurposes } from "@/lib/catalogue";
import { draftPayloadSchema } from "@/lib/intake";
import { intakeSourceLabels, type IntakeSource, type ValidationIssue } from "@/lib/consent";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Review draft" };

interface DraftRow {
  id: string;
  source: IntakeSource;
  status: string;
  payload: unknown;
  validation: ValidationIssue[];
  rejected_reason: string | null;
  evidence_id: string | null;
  evidence_filename: string | null;
  evidence_content_type: string | null;
}

export default async function ReviewDraftPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const { draftId } = await params;
  const [purposes, notices] = await Promise.all([loadPurposes(), loadNotices()]);

  const { rows } = await query<DraftRow>(
    `SELECT d.id, d.source, d.status, d.payload, d.validation, d.rejected_reason,
            d.evidence_id,
            e.original_filename AS evidence_filename,
            e.content_type      AS evidence_content_type
       FROM intake_draft d
       LEFT JOIN evidence_object e ON e.id = d.evidence_id
      WHERE d.id = $1`,
    [draftId],
  );

  const draft = rows[0];
  if (!draft) notFound();

  if (draft.status !== "needs_review") {
    return (
      <Panel title={`This draft is ${draft.status}`}>
        <p className="text-sm text-muted">
          {draft.status === "committed"
            ? "It has already become a permanent artifact. A correction is recorded as a new form, never an edit to this one."
            : `Rejected: ${draft.rejected_reason ?? "no reason recorded"}`}
        </p>
      </Panel>
    );
  }

  const parsed = draftPayloadSchema.safeParse(draft.payload);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Review this form</h1>
        <p className="mt-1 text-sm text-muted">
          {intakeSourceLabels[draft.source]} · check every field against the scan before
          committing.
        </p>
      </div>

      {parsed.success ? (
        <DraftForm
          purposes={purposes}
          notices={notices}
          draftId={draft.id}
          initialPayload={parsed.data}
          initialValidation={draft.validation}
          initialEvidence={
            draft.evidence_id
              ? {
                  id: draft.evidence_id,
                  filename: draft.evidence_filename ?? "scan",
                  contentType: draft.evidence_content_type ?? "image/jpeg",
                }
              : null
          }
        />
      ) : (
        <Panel title="This draft cannot be opened">
          <p className="text-sm text-muted">
            Its stored contents do not match the expected shape, so it cannot be edited
            safely. Reject it and digitise the form again.
          </p>
        </Panel>
      )}
    </div>
  );
}
