import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { query } from "@/lib/db";
import { draftPayloadSchema, matchPrincipal, validateDraft } from "@/lib/intake";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  payload: draftPayloadSchema,
  evidenceId: z.string().uuid().nullable().optional(),
  signatureEvidenceId: z.string().uuid().nullable().optional(),
});

/** Saves reviewer edits. Only a draft still awaiting review can be edited. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireStaff();
    const { id } = await params;
    const body = schema.parse(await request.json());

    const { rows: purposeRows } = await query<{ id: string }>("SELECT id FROM purpose");
    const issues = validateDraft(body.payload, new Set(purposeRows.map((r) => r.id)));
    const { exact, candidates } = await matchPrincipal(body.payload);

    const { rowCount } = await query(
      `UPDATE intake_draft
          SET payload = $2,
              validation = $3,
              matched_principal_id = $4,
              match_reason = $5,
              evidence_id = COALESCE($6, evidence_id),
              signature_evidence_id = COALESCE($7, signature_evidence_id)
        WHERE id = $1 AND status = 'needs_review'`,
      [
        id,
        JSON.stringify(body.payload),
        JSON.stringify(issues),
        exact?.principalId ?? null,
        exact ? exact.reason : "none",
        body.evidenceId ?? null,
        body.signatureEvidenceId ?? null,
      ],
    );

    if (rowCount === 0) {
      return json({ error: "This draft is no longer open for editing" }, 409);
    }

    return json({
      ok: true,
      validation: issues,
      matchedPrincipalId: exact?.principalId ?? null,
      duplicateCandidates: candidates,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
