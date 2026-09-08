import { z } from "zod";
import { query } from "@/lib/db";
import {
  assertSameOrigin,
  hashPassword,
  setStaffCookie,
  signStaffToken,
  verifyPassword,
} from "@/lib/auth";
import { clientIp, userAgent, writeAudit } from "@/lib/audit";
import { errorResponse, json } from "@/lib/http";
import { isStaffRole } from "@/lib/consent";

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const WINDOW_MINUTES = 15;
const MAX_FAILURES = 5;

/**
 * Failed attempts are counted from audit_log rather than from a dedicated
 * table: the failures have to be recorded as evidence regardless, so counting
 * them there avoids a second store and keeps the limit and the audit trail in
 * agreement. Limited per email AND per IP - per email alone lets one attacker
 * work through a user list, per IP alone lets a botnet through.
 */
async function tooManyFailures(email: string, ip: string | null): Promise<boolean> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log
      WHERE action = 'staff_login_failed'
        AND "timestamp" > now() - ($1 || ' minutes')::interval
        AND (new_state->>'email' = $2 OR ($3::text IS NOT NULL AND host(ip_address) = $3))`,
    [String(WINDOW_MINUTES), email, ip],
  );
  return Number(rows[0].n) >= MAX_FAILURES;
}

export async function POST(request: Request) {
  try {
    // auth.ts says every mutating staff route checks Origin, and this one did
    // not. Login CSRF is the quiet one: an attacker signs a DPO into an account
    // they control, and everything that person then types goes into it.
    assertSameOrigin(request);
    const { email, password } = schema.parse(await request.json());
    const ip = clientIp(request);
    const ua = userAgent(request);

    if (await tooManyFailures(email, ip)) {
      return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    }

    const { rows } = await query<{
      id: string;
      password_hash: string;
      role: string;
      is_active: boolean;
    }>(
      "SELECT id, password_hash, role, is_active FROM staff_user WHERE email = $1",
      [email],
    );
    const user = rows[0];

    // Hash a throwaway password when the account does not exist, so that the
    // response time does not distinguish an unknown email from a wrong one.
    const ok = user
      ? await verifyPassword(password, user.password_hash)
      : (await hashPassword(password), false);

    if (!user || !ok || !user.is_active || !isStaffRole(user.role)) {
      await writeAudit({
        action: "staff_login_failed",
        actorType: "staff",
        actorId: user?.id ?? null,
        // The email is recorded because it is the thing being rate limited and
        // an authentication failure is exactly what an audit log is for.
        newState: { email },
        ipAddress: ip,
        userAgent: ua,
      });
      return json({ error: "Email or password is incorrect" }, 401);
    }

    await setStaffCookie(signStaffToken(user.id, user.role));
    await query("UPDATE staff_user SET last_login_at = now() WHERE id = $1", [user.id]);
    await writeAudit({
      action: "staff_login",
      actorType: "staff",
      actorId: user.id,
      newState: { role: user.role },
      ipAddress: ip,
      userAgent: ua,
    });

    return json({ ok: true, role: user.role });
  } catch (error) {
    return errorResponse(error);
  }
}
