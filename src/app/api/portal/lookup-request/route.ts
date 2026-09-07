import { z } from "zod";
import { assertSameOrigin } from "@/lib/auth";
import { withTransaction } from "@/lib/db";
import { clientIp, userAgent } from "@/lib/audit";
import { fileLookupRequest } from "@/lib/lookup";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  claimedName: z.string().trim().min(2).max(200),
  contactNote: z.string().trim().min(5).max(2000),
  formReference: z.string().trim().max(200).nullable().default(null),
});

/**
 * The escape hatch for a contact point that was transcribed wrongly.
 *
 * Without this, a typo made while digitising somebody's form silently and
 * permanently blocks their right to withdraw. It files a note for a human; it
 * never confirms or denies whether the person is in the register, because that
 * would be the enumeration oracle the OTP flow is careful to avoid.
 *
 * Note what is NOT here: no principal token. This endpoint is for people who
 * cannot authenticate - that is the entire premise - so the Origin check and
 * the per-address limit are the only controls available, and both guard the
 * queue's readability rather than the register's secrecy. There is nothing to
 * enumerate through this route: the caller supplies details and learns nothing
 * back about whether they matched.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = schema.parse(await request.json());

    // One transaction, so the row and its audit entry cannot come apart.
    // Called on the pool this ran as three autocommit statements: a
    // writeAudit that threw after the INSERT committed would leave a filed
    // request with no `lookup_request_filed` entry - and that entry is the
    // only honest measure of how badly transcription is going upstream.
    // README invariant 3 is the rule; this is it applied.
    const result = await withTransaction((client) =>
      fileLookupRequest(body, clientIp(request), userAgent(request), client),
    );

    if ("rateLimited" in result) {
      // Said plainly rather than silently dropped: someone who believes a human
      // has been reached, when no row was written, is the failure this whole
      // table exists to prevent.
      return json(
        {
          error:
            "Several requests have already been filed from here today. Someone will work through them - please give it a day before filing another.",
        },
        429,
      );
    }

    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
