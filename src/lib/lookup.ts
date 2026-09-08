/**
 * The queue behind the portal's "can't find your record?" link.
 *
 * This table existed from migration 010 and nothing ever read it. That is worse
 * than not having built it: the public form told people they had reached a
 * human, and the row landed somewhere no human would ever open. The person who
 * most needed the fallback got a confirmation message and silence.
 *
 * What makes this queue different from the notice and cessation queues is that
 * the people in it are NOT YET IDENTIFIED. There is no data_principal_id to
 * hang anything on - finding out who they are is the work. So:
 *
 *   - the audit entries here carry no dataPrincipalId until one is resolved,
 *     and the resolving entry is the first thing that ties a person to a
 *     request;
 *   - nothing in this module searches the register on the requester's behalf.
 *     A DPO reads the note and uses register search, which is already audited
 *     as staff_viewed_principal. Automating that lookup would rebuild the
 *     enumeration oracle the portal is careful never to be, only staffed.
 */
import "server-only";
import { createHash } from "node:crypto";
import { writeAudit } from "@/lib/audit";
import { pool, type Executor } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Generous, and deliberately so. The limit exists to keep the queue readable,
 * not to ration a statutory right - see migration 013.
 */
const REQUESTS_PER_IP_PER_DAY = 5;

/**
 * The cap that applies when there is NO address to count against.
 *
 * This is the important one, and its absence was a real hole. `clientIp()`
 * returns null unless TRUST_PROXY says a proxy sets the header, and TRUST_PROXY
 * DEFAULTS TO FALSE - so in the shipped configuration the per-address limit
 * counted nothing and this endpoint was exactly what migration 013 says must
 * never ship: unauthenticated and unthrottled.
 *
 * The OTP flow survives the same condition because it always has a second
 * dimension, the destination. This route has none: the whole premise is that we
 * cannot identify the caller yet. So when the address is unknown the limit
 * falls back to a GLOBAL ceiling on how many requests the queue will accept in
 * a day. Higher than the per-address cap, because it is shared by everybody -
 * but finite, because an unbounded public write into the table that holds the
 * last escape hatch for s.6(4) is worse than a queue that occasionally says
 * "try tomorrow".
 */
const REQUESTS_PER_DAY_WITHOUT_ADDRESS = 200;

export type LookupStatus = "open" | "resolved" | "rejected";

export interface LookupRequestRow {
  id: string;
  claimed_name: string;
  contact_note: string;
  form_reference: string | null;
  status: LookupStatus;
  created_at: Date;
  handled_at: Date | null;
  handled_by_name: string | null;
  resolved_principal_id: string | null;
  resolved_principal_name: string | null;
  waiting_days: number;
}

const hashIp = (ip: string | null): string | null =>
  ip === null ? null : createHash("sha256").update(`${ip}${env.OTP_PEPPER}`).digest("hex");

/**
 * Files a request, or refuses it as over the limit.
 *
 * Unlike requestOtp this does not have to disguise its outcome: the caller is
 * telling us they are NOT in the register under the details they tried, so
 * there is nothing here to enumerate. An honest "you have filed several today"
 * is better than a silent discard, which would leave someone believing a human
 * had been reached.
 */
export async function fileLookupRequest(
  input: { claimedName: string; contactNote: string; formReference: string | null },
  ip: string | null,
  userAgentString: string | null,
  executor: Executor = pool,
): Promise<{ id: string } | { rateLimited: true }> {
  const ipHash = hashIp(ip);
  const ceiling = ipHash === null ? REQUESTS_PER_DAY_WITHOUT_ADDRESS : REQUESTS_PER_IP_PER_DAY;

  // The limit lives INSIDE the insert, not in a SELECT before it.
  //
  // Counting first and inserting second is two statements, and on the pool they
  // are two connections with no transaction between them - so N simultaneous
  // callers all read the same count and all insert. src/lib/otp.ts already
  // solved this and says why: express the precondition as a WHERE clause and
  // check rowCount, so concurrent requests produce one winner. That lesson did
  // not get carried over here the first time.
  //
  // When ip_hash is null the subquery counts EVERY recent row rather than none,
  // which is what turns the unknown-address case from "no limit" into "the
  // global ceiling".
  const { rows } = await executor.query<{ id: string }>(
    `INSERT INTO principal_lookup_request
       (claimed_name, contact_note, form_reference, ip_hash)
     SELECT $1, $2, $3, $4
      WHERE (SELECT count(*) FROM principal_lookup_request
              WHERE created_at > now() - interval '1 day'
                AND ($4::text IS NULL OR ip_hash = $4)) < $5
     RETURNING id`,
    [input.claimedName, input.contactNote, input.formReference, ipHash, ceiling],
  );

  if (rows.length === 0) return { rateLimited: true };

  // Audited because this is a person asserting a s.6(4) right and being unable
  // to exercise it. The count of these, and how long they sit, is the honest
  // measure of how badly the transcription went.
  await writeAudit(
    {
      action: "lookup_request_filed",
      actorType: "data_principal",
      newState: { requestId: rows[0].id, claimedName: input.claimedName },
      complianceTags: ["dpdp_s6_4"],
      ipAddress: ip,
      userAgent: userAgentString,
    },
    executor,
  );

  return { id: rows[0].id };
}

/** The worked queue, longest waiting first. */
export async function loadLookupRequests(
  status: LookupStatus = "open",
  executor: Executor = pool,
): Promise<LookupRequestRow[]> {
  const { rows } = await executor.query<LookupRequestRow>(
    `SELECT r.id,
            r.claimed_name,
            r.contact_note,
            r.form_reference,
            r.status,
            r.created_at,
            r.handled_at,
            s.full_name AS handled_by_name,
            r.resolved_principal_id,
            d.full_name AS resolved_principal_name,
            floor(extract(epoch FROM now() - r.created_at) / 86400)::int AS waiting_days
       FROM principal_lookup_request r
       LEFT JOIN staff_user s     ON s.id = r.handled_by
       LEFT JOIN data_principal d ON d.id = r.resolved_principal_id
      WHERE r.status = $1
      ORDER BY r.created_at
      LIMIT 300`,
    [status],
  );
  return rows;
}

export async function countOpenLookupRequests(
  executor: Executor = pool,
): Promise<{ open: number; stale: number }> {
  const { rows } = await executor.query<{ open: string; stale: string }>(
    `SELECT count(*)                                                        AS open,
            count(*) FILTER (WHERE created_at < now() - interval '7 days')  AS stale
       FROM principal_lookup_request
      WHERE status = 'open'`,
  );
  return { open: Number(rows[0].open), stale: Number(rows[0].stale) };
}

/**
 * Closes a request against the person it turned out to be.
 *
 * The principal id is recorded so the trail can later answer "how did this
 * person reach their record?" - which is the question a Board query about
 * s.6(4) actually asks. This is also the first moment the request stops being
 * anonymous, so it is the first audit entry that can carry a dataPrincipalId.
 */
export async function resolveLookupRequest(
  id: string,
  staffId: string,
  principalId: string,
  note: string,
  client: Executor,
): Promise<boolean> {
  const { rows } = await client.query<{ claimed_name: string }>(
    `UPDATE principal_lookup_request
        SET status = 'resolved', handled_by = $2, handled_at = now(),
            resolved_principal_id = $3
      WHERE id = $1 AND status = 'open'
      RETURNING claimed_name`,
    [id, staffId, principalId],
  );
  if (rows.length === 0) return false;

  await writeAudit(
    {
      action: "lookup_request_resolved",
      actorType: "staff",
      actorId: staffId,
      dataPrincipalId: principalId,
      newState: { requestId: id, claimedName: rows[0].claimed_name },
      reason: note,
      complianceTags: ["dpdp_s6_4"],
    },
    client,
  );
  return true;
}

/**
 * Closes a request that could not be matched to anybody.
 *
 * Kept rather than deleted, and the reason is required. A person who cannot be
 * found in the register may simply not be in it - but "we looked and could not
 * find you" is a finding a regulator may want to see, and a rising count of
 * these is the signal that intake transcription is going wrong upstream.
 */
export async function rejectLookupRequest(
  id: string,
  staffId: string,
  note: string,
  client: Executor,
): Promise<boolean> {
  const { rows } = await client.query<{ claimed_name: string }>(
    `UPDATE principal_lookup_request
        SET status = 'rejected', handled_by = $2, handled_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING claimed_name`,
    [id, staffId],
  );
  if (rows.length === 0) return false;

  await writeAudit(
    {
      action: "lookup_request_rejected",
      actorType: "staff",
      actorId: staffId,
      newState: { requestId: id, claimedName: rows[0].claimed_name },
      reason: note,
      complianceTags: ["dpdp_s6_4"],
    },
    client,
  );
  return true;
}
