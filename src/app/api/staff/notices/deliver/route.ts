import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { withTransaction } from "@/lib/db";
import { recordNoticeDelivered } from "@/lib/notices";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  principalId: z.string().uuid(),
  channel: z.enum(["post", "email", "sms", "in_person"]),
  // "Delivered" with no account of how is not evidence a regulator can check.
  note: z.string().trim().min(4, "Say how the notice reached them").max(500),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff("dpo");
    const body = schema.parse(await request.json());

    await withTransaction((client) =>
      recordNoticeDelivered({ ...body, staffId: staff.staffId }, client),
    );
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
