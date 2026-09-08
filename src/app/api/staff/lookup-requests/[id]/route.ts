import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { withTransaction } from "@/lib/db";
import { rejectLookupRequest, resolveLookupRequest } from "@/lib/lookup";
import { errorResponse, json } from "@/lib/http";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("resolve"),
    principalId: z.string().uuid("Choose the person this turned out to be"),
    note: z.string().trim().min(4, "Say how you matched them").max(500),
  }),
  z.object({
    action: z.literal("reject"),
    // Required, and longer: closing the only route back for someone who cannot
    // reach their record is a decision that has to survive being read later.
    note: z.string().trim().min(8, "Say what you searched and what you found").max(500),
  }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff("dpo");
    const { id } = await params;
    const body = schema.parse(await request.json());

    const done = await withTransaction((client) =>
      body.action === "resolve"
        ? resolveLookupRequest(id, staff.staffId, body.principalId, body.note, client)
        : rejectLookupRequest(id, staff.staffId, body.note, client),
    );

    if (!done) {
      return json({ error: "That request has already been handled" }, 409);
    }
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
