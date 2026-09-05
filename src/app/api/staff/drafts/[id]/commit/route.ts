import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { withTransaction } from "@/lib/db";
import { clientIp, userAgent } from "@/lib/audit";
import { CommitError, commitDraft } from "@/lib/intake";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  confirmPrincipalId: z.string().uuid().nullable().default(null),
  forceNew: z.boolean().default(false),
});

const STATUS: Record<string, number> = {
  draft_not_found: 404,
  draft_not_reviewable: 409,
  validation_failed: 400,
  possible_duplicate: 409,
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff();
    const { id } = await params;
    const body = schema.parse(await request.json().catch(() => ({})));

    const result = await withTransaction((client) =>
      commitDraft(
        {
          draftId: id,
          staffId: staff.staffId,
          confirmPrincipalId: body.confirmPrincipalId,
          forceNew: body.forceNew,
          ipAddress: clientIp(request),
          userAgent: userAgent(request),
        },
        client,
      ),
    );

    return json(result);
  } catch (error) {
    if (error instanceof CommitError) {
      return json(
        { error: error.message, code: error.code, detail: error.detail ?? null },
        STATUS[error.code] ?? 400,
      );
    }
    return errorResponse(error);
  }
}
