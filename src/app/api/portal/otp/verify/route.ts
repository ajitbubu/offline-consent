import { z } from "zod";
import { signPrincipalToken } from "@/lib/auth";
import { clientIp, userAgent, writeAudit } from "@/lib/audit";
import { loadPrincipalNames, verifyOtp } from "@/lib/otp";
import { otpSchema } from "@/lib/consent";
import { maskName } from "@/lib/phone";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({ challengeId: z.string().uuid(), code: otpSchema });

export async function POST(request: Request) {
  try {
    const { challengeId, code } = schema.parse(await request.json());
    const ip = clientIp(request);
    const ua = userAgent(request);

    const result = await verifyOtp(challengeId, code, ip);

    if ("rateLimited" in result) {
      return json({ error: "Too many attempts. Please try again later." }, 429);
    }

    if (!result.ok) {
      await writeAudit({
        action: "otp_failed",
        actorType: "system",
        newState: { challengeId },
        ipAddress: ip,
        userAgent: ua,
      });
      return json({ error: "That code is not right, or it has expired." }, 401);
    }

    // A contact point shared by a household resolves to more than one person.
    // The names are masked: proving control of the phone does not entitle the
    // holder to a roster of everyone who used it.
    if (result.principalIds.length > 1) {
      const people = await loadPrincipalNames(result.principalIds);
      return json({
        needsSelection: true,
        people: people.map((p) => ({ id: p.id, maskedName: maskName(p.full_name) })),
      });
    }

    const principalId = result.principalIds[0];

    await writeAudit({
      action: "otp_verified",
      actorType: "data_principal",
      actorId: principalId,
      dataPrincipalId: principalId,
      newState: { challengeId },
      ipAddress: ip,
      userAgent: ua,
    });

    return json({ token: signPrincipalToken(principalId) });
  } catch (error) {
    return errorResponse(error);
  }
}
