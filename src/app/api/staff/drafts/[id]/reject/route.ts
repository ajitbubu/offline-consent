import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { query } from "@/lib/db";
import { clientIp, userAgent, writeAudit } from "@/lib/audit";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({ reason: z.string().trim().min(3, "Say why this is being rejected") });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff();
    const { id } = await params;
    const { reason } = schema.parse(await request.json());

    const { rowCount } = await query(
      `UPDATE intake_draft
          SET status = 'rejected', rejected_reason = $2, reviewed_by = $3, reviewed_at = now()
        WHERE id = $1 AND status = 'needs_review'`,
      [id, reason, staff.staffId],
    );

    if (rowCount === 0) return json({ error: "This draft is no longer open" }, 409);

    await writeAudit({
      action: "draft_rejected",
      actorType: "staff",
      actorId: staff.staffId,
      newState: { draftId: id },
      reason,
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
    });

    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
