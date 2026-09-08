/**
 * Authentication for two entirely separate credential classes.
 *
 *   staff           - email and password, a role, an ambient cookie, 8 hours.
 *   data principal  - an OTP to a contact point, no role, no cookie, 15 minutes.
 *
 * They share a signing secret but are separated by JWT audience, and the
 * verifiers refuse to cross over. That separation is the single most important
 * boundary in this application: without it a withdrawal link sitting in
 * somebody's mailbox becomes a key to every record in the register.
 */
import "server-only";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { query } from "@/lib/db";
import { resolvePrincipalId } from "@/lib/principal";
import { isStaffRole, roleAtLeast, type StaffRole } from "@/lib/consent";

export const STAFF_AUDIENCE = "offline-consent-staff";
export const PRINCIPAL_AUDIENCE = "offline-consent-principal";

export const STAFF_COOKIE = "oc_staff";

const STAFF_TTL_SECONDS = 8 * 60 * 60;
/** Short by design: a withdrawal is a single sitting, not a session. */
const PRINCIPAL_TTL_SECONDS = 15 * 60;

const BCRYPT_COST = 12;

/** Thrown by the require* guards. Route handlers map this to a status code. */
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                  */
/* -------------------------------------------------------------------------- */

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, BCRYPT_COST);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

export interface StaffContext {
  staffId: string;
  role: StaffRole;
}

export interface PrincipalContext {
  principalId: string;
}

export function signStaffToken(staffId: string, role: StaffRole): string {
  return jwt.sign({ role }, env.JWT_SECRET, {
    algorithm: "HS256",
    audience: STAFF_AUDIENCE,
    subject: staffId,
    expiresIn: STAFF_TTL_SECONDS,
  });
}

export function signPrincipalToken(principalId: string): string {
  // No role, no email, no phone. The token carries an identity and nothing
  // else, so a leaked one discloses nothing on its own.
  return jwt.sign({}, env.JWT_SECRET, {
    algorithm: "HS256",
    audience: PRINCIPAL_AUDIENCE,
    subject: principalId,
    expiresIn: PRINCIPAL_TTL_SECONDS,
  });
}

interface VerifiedToken<T> {
  context: T;
  issuedAt: number; // seconds since epoch
}

/**
 * Pure verification: signature, algorithm, audience, expiry. No database read.
 * The require* functions below add the revocation-cutoff check on top, mirroring
 * the verify()/verifyActive() split in the DSG platform's token service.
 */
function verifyStaffToken(token: string): VerifiedToken<StaffContext> {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
      audience: STAFF_AUDIENCE,
    }) as jwt.JwtPayload;
  } catch {
    throw new AuthError(401, "Invalid or expired session");
  }

  // Belt and braces over the audience check above. A principal token must never
  // satisfy a staff guard even if the audience check were ever loosened, so the
  // required shape is asserted independently: staff tokens carry a valid role.
  const role = (payload as { role?: unknown }).role;
  if (!isStaffRole(role)) throw new AuthError(401, "Invalid or expired session");
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new AuthError(401, "Invalid or expired session");
  }
  if (typeof payload.iat !== "number") {
    throw new AuthError(401, "Invalid or expired session");
  }

  return { context: { staffId: payload.sub, role }, issuedAt: payload.iat };
}

function verifyPrincipalToken(token: string): VerifiedToken<PrincipalContext> {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
      audience: PRINCIPAL_AUDIENCE,
    }) as jwt.JwtPayload;
  } catch {
    throw new AuthError(401, "Invalid or expired session");
  }

  // The mirror image of the staff assertion: a principal token must carry no
  // role at all, so a staff token can never satisfy a portal guard.
  if ("role" in payload) throw new AuthError(401, "Invalid or expired session");
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new AuthError(401, "Invalid or expired session");
  }
  if (typeof payload.iat !== "number") {
    throw new AuthError(401, "Invalid or expired session");
  }

  return { context: { principalId: payload.sub }, issuedAt: payload.iat };
}

/**
 * `iat` has one-second resolution, so a token minted in the same second as a
 * revocation cannot be distinguished from one minted just before it. Treating
 * that tie as revoked errs toward refusing a session that might be valid, which
 * is the right direction for a register of this kind.
 */
const revokedBy = (issuedAt: number, cutoff: Date | null): boolean =>
  cutoff !== null && issuedAt * 1000 <= cutoff.getTime();

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Verifies the staff cookie and confirms the account is still active and the
 * token has not been revoked. Reads the database on every request, so a
 * deactivation or role downgrade takes effect on the next call rather than
 * whenever the token happens to expire.
 */
export async function requireStaff(minimumRole?: StaffRole): Promise<StaffContext> {
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) throw new AuthError(401, "Not signed in");

  const { context, issuedAt } = verifyStaffToken(token);

  const { rows } = await query<{
    role: string;
    is_active: boolean;
    tokens_valid_from: Date | null;
  }>(
    "SELECT role, is_active, tokens_valid_from FROM staff_user WHERE id = $1",
    [context.staffId],
  );

  const user = rows[0];
  if (!user || !user.is_active) throw new AuthError(401, "Account is not active");
  if (revokedBy(issuedAt, user.tokens_valid_from)) {
    throw new AuthError(401, "Session has been revoked");
  }

  // The role in the database wins over the role in the token, so a downgrade
  // cannot be outrun by a token minted before it.
  if (!isStaffRole(user.role)) throw new AuthError(403, "Unknown role");
  const current: StaffContext = { staffId: context.staffId, role: user.role };

  if (minimumRole && !roleAtLeast(current.role, minimumRole)) {
    throw new AuthError(403, "Insufficient permissions");
  }

  return current;
}

/**
 * Verifies a data principal's bearer token.
 *
 * The identity is taken from the token's subject and from nowhere else. No
 * route in the portal accepts a principal id, phone number or email address in
 * a path, query string or body - the one exception being OTP selection, which
 * validates the chosen id against the set frozen on the challenge at send time.
 */
export async function requirePrincipal(request: Request): Promise<PrincipalContext> {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) throw new AuthError(401, "Not signed in");

  const { context, issuedAt } = verifyPrincipalToken(token);

  const { rows } = await query<{ portal_tokens_valid_from: Date | null }>(
    "SELECT portal_tokens_valid_from FROM data_principal WHERE id = $1",
    [context.principalId],
  );

  const principal = rows[0];
  if (!principal) throw new AuthError(401, "Record not found");
  if (revokedBy(issuedAt, principal.portal_tokens_valid_from)) {
    throw new AuthError(401, "Session has been revoked");
  }

  // Follow the merge chain. This row previously read merged_into_id and did
  // nothing with it, so a token issued before a DPO merged this person into
  // another kept resolving to the absorbed identity - whose consent records the
  // portal would then show as the whole story, and whose withdraw button would
  // act on nothing.
  const survivingId = await resolvePrincipalId(context.principalId);
  if (survivingId === null) throw new AuthError(401, "Record not found");

  if (survivingId !== context.principalId) {
    // The survivor's own revocation cutoff applies too: revoking the person
    // must not be defeated by presenting a token minted for the identity that
    // was folded into them.
    const { rows: surviving } = await query<{ portal_tokens_valid_from: Date | null }>(
      "SELECT portal_tokens_valid_from FROM data_principal WHERE id = $1",
      [survivingId],
    );
    if (revokedBy(issuedAt, surviving[0]?.portal_tokens_valid_from ?? null)) {
      throw new AuthError(401, "Session has been revoked");
    }
  }

  return { principalId: survivingId };
}

/* -------------------------------------------------------------------------- */
/* CSRF                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The staff cookie is an ambient credential, so every mutating staff route
 * checks the Origin header. SameSite=Lax alone does not cover every case, and
 * the portal needs no equivalent because its token is never ambient.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin === null) {
    // A same-origin fetch from a browser always sends Origin on a mutating
    // request. Its absence means this did not come from the app.
    throw new AuthError(403, "Missing origin");
  }
  if (origin !== env.APP_ORIGIN) throw new AuthError(403, "Cross-origin request refused");
}

/* -------------------------------------------------------------------------- */
/* Cookie helpers                                                             */
/* -------------------------------------------------------------------------- */

export async function setStaffCookie(token: string): Promise<void> {
  (await cookies()).set(STAFF_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STAFF_TTL_SECONDS,
  });
}

export async function clearStaffCookie(): Promise<void> {
  (await cookies()).delete(STAFF_COOKIE);
}
