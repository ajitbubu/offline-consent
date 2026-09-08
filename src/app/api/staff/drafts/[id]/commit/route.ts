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
  already_recorded: 409,
};

/**
 * Two commits for the same person can still collide below the application:
 * 23505 if they race on a unique index, 40P01/40001 if the database breaks a
 * lock cycle. Both roll the whole transaction back, so nothing partial lands -
 * but errorResponse would report them as "Something went wrong", which tells
 * the reviewer neither what happened nor that retrying is the right move.
 */
const RETRYABLE_PG_CODES = new Set(["23505", "40P01", "40001"]);

const pgCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
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
    const code = pgCode(error);
    if (code !== null && RETRYABLE_PG_CODES.has(code)) {
      console.error("Concurrent commit conflict", code, error);
      return json(
        {
          error: "Someone else was committing for this person at the same time. Nothing was saved - open the draft and commit again.",
          code: "concurrent_commit",
        },
        409,
      );
    }
    return errorResponse(error);
  }
}
