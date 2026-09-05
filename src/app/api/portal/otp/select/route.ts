import { z } from "zod";
import { signPrincipalToken } from "@/lib/auth";
import { clientIp, userAgent, writeAudit } from "@/lib/audit";
import { claimPrincipal } from "@/lib/otp";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  challengeId: z.string().uuid(),
  principalId: z.string().uuid(),
});

/**
 * The only portal endpoint that accepts an identifier from the client, and the
 * id is checked against the set frozen on the challenge when the code was sent
 * - so naming an arbitrary principal gets you nothing.
 */
export async function POST(request: Request) {
  try {
    const { challengeId, principalId } = schema.parse(await request.json());

    const allowed = await claimPrincipal(challengeId, principalId);
    if (!allowed) return json({ error: "That selection is no longer valid." }, 401);

    await writeAudit({
      action: "principal_selected",
      actorType: "data_principal",
      actorId: principalId,
      dataPrincipalId: principalId,
      newState: { challengeId },
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
    });

    return json({ token: signPrincipalToken(principalId) });
  } catch (error) {
    return errorResponse(error);
  }
}
