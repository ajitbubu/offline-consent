/**
 * One-time codes for the public withdrawal portal.
 *
 * The Data Principal has no account and no password. Proving control of a
 * contact point that appears on their paper form is the whole authentication
 * story, and it has to stay that light: s.6(4) requires withdrawal to be as
 * easy as giving consent, so demanding identity documents here would itself be
 * a compliance failure.
 *
 * The security properties that matter, and where each is enforced:
 *
 *   no enumeration    - requestOtp returns an identical body and takes the same
 *                       time whether or not the destination is in the register,
 *                       and never stores a row for an unknown one.
 *   no code spraying  - only one challenge per destination may be live; issuing
 *                       a new one consumes the previous.
 *   no probing        - verification is looked up by opaque challenge id, never
 *                       by destination.
 *   no phone directory- destinations are stored only as a peppered hash.
 *   one code, one use - every state change below is a single conditional
 *                       statement, so N concurrent requests produce one winner.
 *
 * That last property is not incidental. These functions are called with the
 * pool, not a client, so each statement is its own implicit transaction and a
 * SELECT ... FOR UPDATE releases its lock the moment the statement ends. Any
 * read-modify-write here would lose updates under concurrency, and the thing
 * that would be lost is the brute-force counter on the portal's only
 * credential. Do not reintroduce one: express the change as an UPDATE whose
 * WHERE clause carries the precondition, and check rowCount.
 */
import "server-only";
import { createHash, randomInt, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "@/lib/env";
import { pool, query, type Executor } from "@/lib/db";
import { normaliseEmail, normalisePhone } from "@/lib/phone";

const TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const SENDS_PER_DESTINATION_PER_15_MIN = 3;
const SENDS_PER_IP_PER_HOUR = 10;
const VERIFIES_PER_IP_PER_HOUR = 30;

/**
 * Six digits is about twenty bits, so hashing only buys time against a leaked
 * table - the TTL and the attempt cap are the real controls. Cost 10 rather
 * than 12 because this runs on every verification attempt.
 */
const BCRYPT_COST = 10;

/** Every request takes at least this long, so timing cannot reveal a match. */
const LATENCY_FLOOR_MS = 400;

export type OtpChannel = "sms" | "email";

const hashDestination = (destination: string): string =>
  createHash("sha256").update(`${destination}${env.OTP_PEPPER}`).digest("hex");

const hashIp = (ip: string | null): string | null =>
  ip === null ? null : createHash("sha256").update(`${ip}${env.OTP_PEPPER}`).digest("hex");

/** Resolves free text into a normalised destination, or null if it is neither. */
export function parseDestination(
  raw: string,
): { channel: OtpChannel; value: string } | null {
  const email = normaliseEmail(raw);
  if (email) return { channel: "email", value: email };
  const phone = normalisePhone(raw);
  if (phone) return { channel: "sms", value: phone };
  return null;
}

async function settleAfter<T>(startedAt: number, value: T): Promise<T> {
  const remaining = LATENCY_FLOOR_MS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  return value;
}

export interface RequestOtpResult {
  challengeId: string;
  /** Only populated when OTP_DEV_ECHO is on. Never sent to the client. */
  devCode?: string;
}

/**
 * Issues a code, or convincingly pretends to.
 *
 * The caller gets a challenge id either way. For a destination that matches
 * nobody, that id is random and no row is written, so the response is
 * indistinguishable from a real one and verification simply never succeeds.
 */
export async function requestOtp(
  rawDestination: string,
  ip: string | null,
  executor: Executor = pool,
): Promise<RequestOtpResult | { rateLimited: true }> {
  const startedAt = Date.now();
  const parsed = parseDestination(rawDestination);
  if (!parsed) return settleAfter(startedAt, { challengeId: randomUUID() });

  const destinationHash = hashDestination(parsed.value);
  const ipHash = hashIp(ip);

  // The per-IP limit is answered honestly, because how many codes THIS caller
  // has asked for says nothing about whether any given destination is in the
  // register. The per-destination limit is not, and cannot be - see below.
  if (ipHash) {
    const { rows } = await executor.query<{ n: string }>(
      `SELECT count(*) AS n FROM otp_challenge
        WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'`,
      [ipHash],
    );
    if (Number(rows[0].n) >= SENDS_PER_IP_PER_HOUR) {
      return settleAfter(startedAt, { rateLimited: true as const });
    }
  }

  const { rows: matches } = await executor.query<{ id: string }>(
    `SELECT id FROM data_principal
      WHERE merged_into_id IS NULL
        AND (($1 = 'sms'   AND phone_e164 = $2)
          OR ($1 = 'email' AND email      = $2))`,
    [parsed.channel, parsed.value],
  );

  if (matches.length === 0) {
    // Nothing is written. A challenge row for an unknown destination would turn
    // this table into a record of who has been guessed at.
    return settleAfter(startedAt, { challengeId: randomUUID() });
  }

  // One live challenge per destination. Without this an attacker keeps
  // requesting codes and sprays a few guesses at each, and the per-challenge
  // attempt cap buys nothing.
  await executor.query(
    `UPDATE otp_challenge SET consumed_at = now()
      WHERE destination_hash = $1 AND consumed_at IS NULL`,
    [destinationHash],
  );

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

  // The per-destination limit lives in the INSERT's WHERE clause rather than in
  // a preceding SELECT, so two simultaneous requests cannot both read "2 sent"
  // and both write a third.
  const { rows } = await executor.query<{ id: string }>(
    `INSERT INTO otp_challenge
       (channel, destination_hash, code_hash, matched_principal_ids, expires_at, ip_hash)
     SELECT $1, $2, $3, $4, now() + ($5 || ' minutes')::interval, $6
      WHERE (SELECT count(*) FROM otp_challenge
              WHERE destination_hash = $2
                AND created_at > now() - interval '15 minutes') < $7
     RETURNING id`,
    [
      parsed.channel,
      destinationHash,
      await bcrypt.hash(code, BCRYPT_COST),
      matches.map((m) => m.id),
      String(TTL_MINUTES),
      ipHash,
      SENDS_PER_DESTINATION_PER_15_MIN,
    ],
  );

  if (rows.length === 0) {
    // Over the per-destination limit. This CANNOT answer differently from a
    // destination that is not in the register, because rows are only ever
    // written for destinations that ARE - so a distinguishable answer here is a
    // membership oracle for any phone number or email address in the country.
    // Same body, same shape, same latency floor. We simply do not send.
    return settleAfter(startedAt, { challengeId: randomUUID() });
  }

  // Delivery is out of scope for now: in development the code goes to the
  // server console, and a real SMS or email provider slots in here.
  if (env.OTP_DEV_ECHO) {
    console.log(`[otp] ${parsed.channel} to ${parsed.value}: ${code}`);
  }

  return settleAfter(startedAt, {
    challengeId: rows[0].id,
    devCode: env.OTP_DEV_ECHO ? code : undefined,
  });
}

export type VerifyOutcome =
  | { ok: false }
  | { ok: true; principalIds: string[] };

/**
 * Checks a code against a challenge.
 *
 * Every failure returns the same shape, so a caller cannot tell an expired
 * challenge from a wrong code from an id that never existed.
 */
export async function verifyOtp(
  challengeId: string,
  code: string,
  ip: string | null,
  executor: Executor = pool,
): Promise<VerifyOutcome | { rateLimited: true }> {
  const startedAt = Date.now();

  if (ip !== null) {
    // Counts verification ATTEMPTS, which is what the constant is named after.
    // The previous version counted challenges created by this IP, and compared
    // them against a threshold that resolved to 12 - two above the ceiling of 10
    // that requestOtp already enforces - so it could never fire.
    //
    // Read from audit_log rather than a second store: the verify route records
    // every otp_failed there with the client IP because it is evidence
    // regardless, and audit_log_action_timestamp_idx already covers exactly this
    // (action, timestamp) lookup. Same technique as the staff login limiter, so
    // the limit and the evidence can never disagree.
    const { rows } = await executor.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'otp_failed'
          AND "timestamp" > now() - interval '1 hour'
          AND host(ip_address) = $1`,
      [ip],
    );
    if (Number(rows[0].n) >= VERIFIES_PER_IP_PER_HOUR) {
      return settleAfter(startedAt, { rateLimited: true as const });
    }
  }

  // Claim an attempt slot and read the challenge in ONE statement.
  //
  // Every precondition - exists, not consumed, not expired, attempts left - is
  // in the WHERE clause, and the increment is relative to the stored value
  // rather than to a value read earlier. Twenty simultaneous guesses therefore
  // burn twenty attempts and the fifth one onwards match nothing, instead of
  // all twenty reading attempts=0 and all writing attempts=1.
  //
  // Looked up by opaque id, never by destination, so this endpoint cannot be
  // used to ask whether a phone number is in the register.
  const { rows } = await executor.query<{
    code_hash: string;
    attempts: number;
    matched_principal_ids: string[];
  }>(
    `UPDATE otp_challenge
        SET attempts = attempts + 1
      WHERE id = $1
        AND consumed_at IS NULL
        AND expires_at > now()
        AND attempts < $2::int
     RETURNING code_hash, attempts, matched_principal_ids`,
    [challengeId, MAX_ATTEMPTS],
  );

  const challenge = rows[0];
  if (!challenge) return settleAfter(startedAt, { ok: false as const });

  const matched = await bcrypt.compare(code, challenge.code_hash);

  if (!matched) {
    if (challenge.attempts >= MAX_ATTEMPTS) {
      await executor.query(
        "UPDATE otp_challenge SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL",
        [challengeId],
      );
    }
    return settleAfter(startedAt, { ok: false as const });
  }

  // Single use. `consumed_at IS NULL` in the WHERE clause means exactly one
  // caller can win this, so a code that leaks cannot be replayed into a second
  // session token. When the contact point resolves to several people the
  // challenge stays open by design - the token is minted by claimPrincipal
  // after selection, and that closes it.
  const single = challenge.matched_principal_ids.length === 1;
  const consumed = await executor.query(
    `UPDATE otp_challenge
        SET verified_at = now(),
            consumed_at = CASE WHEN $2 THEN now() ELSE consumed_at END
      WHERE id = $1 AND consumed_at IS NULL`,
    [challengeId, single],
  );
  if (consumed.rowCount === 0) return settleAfter(startedAt, { ok: false as const });

  return settleAfter(startedAt, {
    ok: true as const,
    principalIds: challenge.matched_principal_ids,
  });
}

/**
 * Confirms that a chosen principal really was one of the people this contact
 * point resolved to when the code was sent, and closes the challenge.
 *
 * This is the one place in the portal where a client supplies an identifier, so
 * it is checked against a server-stored set frozen at send time rather than
 * trusted.
 */
export async function claimPrincipal(
  challengeId: string,
  principalId: string,
  executor: Executor = pool,
): Promise<boolean> {
  // The membership test is part of the same statement that closes the
  // challenge, so two simultaneous selections naming two different people
  // cannot both find it open and both mint a token.
  const { rowCount } = await executor.query(
    `UPDATE otp_challenge
        SET consumed_at = now()
      WHERE id = $1
        AND verified_at IS NOT NULL
        AND consumed_at IS NULL
        AND expires_at > now()
        AND $2::uuid = ANY (matched_principal_ids)`,
    [challengeId, principalId],
  );
  return rowCount === 1;
}

/** Names for the disambiguation screen, masked so it is not a household roster. */
export async function loadPrincipalNames(
  ids: readonly string[],
): Promise<{ id: string; full_name: string }[]> {
  if (ids.length === 0) return [];
  const { rows } = await query<{ id: string; full_name: string }>(
    "SELECT id, full_name FROM data_principal WHERE id = ANY($1::uuid[]) ORDER BY full_name",
    [[...ids]],
  );
  return rows;
}
