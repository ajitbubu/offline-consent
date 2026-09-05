import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { withTransaction } from "@/lib/db";
import { completeTask, holdTask } from "@/lib/cessation";
import { errorResponse, json } from "@/lib/http";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("complete"),
    note: z.string().trim().min(4, "Say what was stopped").max(500),
  }),
  z.object({
    action: z.literal("hold"),
    // s.6(6) permits continued processing only where the Act requires or
    // authorises it, so a hold is a legal claim and has to name its basis.
    note: z.string().trim().min(8, "Name the provision this is held under").max(500),
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
      body.action === "complete"
        ? completeTask(id, staff.staffId, body.note, client)
        : holdTask(id, staff.staffId, body.note, client),
    );

    if (!done) {
      return json({ error: "That task is no longer open" }, 409);
    }
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
