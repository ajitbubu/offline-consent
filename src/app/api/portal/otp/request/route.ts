import { z } from "zod";
import { clientIp, userAgent, writeAudit } from "@/lib/audit";
import { requestOtp } from "@/lib/otp";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({ destination: z.string().trim().min(3).max(320) });

/**
 * Always answers the same way.
 *
 * There is no "no account found" branch, no different error shape, and no
 * shorter response time for an unknown destination - any of those would turn
 * this endpoint into a way to ask whether a given phone number is in the
 * register.
 */
export async function POST(request: Request) {
  try {
    const { destination } = schema.parse(await request.json());
    const ip = clientIp(request);

    const result = await requestOtp(destination, ip);

    if ("rateLimited" in result) {
      return json({ error: "Too many requests. Please try again later." }, 429);
    }

    await writeAudit({
      action: "otp_issued",
      actorType: "system",
      // The destination itself is never written here. Recording it would put a
      // plaintext contact point in the audit log for anyone who guessed it.
      newState: { challengeId: result.challengeId },
      ipAddress: ip,
      userAgent: userAgent(request),
    });

    return json({ ok: true, challengeId: result.challengeId });
  } catch (error) {
    return errorResponse(error);
  }
}
