import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { withTransaction } from "@/lib/db";
import { clientIp, userAgent } from "@/lib/audit";
import { MergeError, mergePrincipals } from "@/lib/merge";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  absorbedId: z.string().uuid(),
  survivorId: z.string().uuid(),
  // Invariant 11 says a merge is always a human's decision. A decision with no
  // stated reason is not much of a decision, and this lands in the audit entry.
  reason: z.string().trim().min(8, "Say why these are the same person").max(500),
});

const STATUS: Record<string, number> = {
  same_person: 400,
  not_found: 404,
  already_merged: 409,
  would_cycle: 409,
};

/** DPO only. Merging is the one write that can fuse two people's consent state. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff("dpo");
    const body = schema.parse(await request.json());

    const result = await withTransaction((client) =>
      mergePrincipals(
        {
          absorbedId: body.absorbedId,
          survivorId: body.survivorId,
          staffId: staff.staffId,
          reason: body.reason,
          ipAddress: clientIp(request),
          userAgent: userAgent(request),
        },
        client,
      ),
    );

    return json(result);
  } catch (error) {
    if (error instanceof MergeError) {
      return json({ error: error.message, code: error.code }, STATUS[error.code] ?? 400);
    }
    return errorResponse(error);
  }
}
