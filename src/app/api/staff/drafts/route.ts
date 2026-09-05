import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { query } from "@/lib/db";
import { clientIp, userAgent, writeAudit } from "@/lib/audit";
import { draftPayloadSchema, matchPrincipal, validateDraft } from "@/lib/intake";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  source: z.enum(["manual", "scan", "kiosk"]),
  payload: draftPayloadSchema,
  evidenceId: z.string().uuid().nullable().default(null),
  signatureEvidenceId: z.string().uuid().nullable().default(null),
  ocrTokens: z.unknown().nullable().default(null),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff();
    const body = schema.parse(await request.json());

    const { rows: purposeRows } = await query<{ id: string }>("SELECT id FROM purpose");
    const issues = validateDraft(body.payload, new Set(purposeRows.map((r) => r.id)));
    const { exact } = await matchPrincipal(body.payload);

    const { rows } = await query<{ id: string }>(
      `INSERT INTO intake_draft
         (source, payload, evidence_id, signature_evidence_id, ocr_tokens,
          matched_principal_id, match_reason, validation, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        body.source,
        JSON.stringify(body.payload),
        body.evidenceId,
        body.signatureEvidenceId,
        body.ocrTokens === null ? null : JSON.stringify(body.ocrTokens),
        exact?.principalId ?? null,
        exact ? exact.reason : "none",
        JSON.stringify(issues),
        staff.staffId,
      ],
    );

    await writeAudit({
      action: "draft_created",
      actorType: "staff",
      actorId: staff.staffId,
      newState: { draftId: rows[0].id, source: body.source },
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
    });

    return json({ id: rows[0].id, validation: issues, matchedPrincipalId: exact?.principalId ?? null });
  } catch (error) {
    return errorResponse(error);
  }
}
