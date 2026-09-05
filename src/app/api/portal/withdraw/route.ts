import { z } from "zod";
import { requirePrincipal } from "@/lib/auth";
import { withTransaction } from "@/lib/db";
import { clientIp, userAgent } from "@/lib/audit";
import { withdrawPurposes } from "@/lib/withdrawal";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  purposeIds: z.array(z.string().uuid()).min(1),
  reason: z.string().trim().max(1000).nullable().default(null),
});

export async function POST(request: Request) {
  try {
    const { principalId } = await requirePrincipal(request);
    const { purposeIds, reason } = schema.parse(await request.json());

    const outcomes = await withTransaction((client) =>
      withdrawPurposes(
        {
          principalId,
          purposeIds,
          channel: "portal",
          reason,
          actorType: "data_principal",
          actorId: principalId,
          ipAddress: clientIp(request),
          userAgent: userAgent(request),
        },
        client,
      ),
    );

    return json({ outcomes });
  } catch (error) {
    return errorResponse(error);
  }
}
