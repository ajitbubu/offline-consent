/**
 * DPO reads over the register (FR-14).
 *
 * Everything here is read-only and DPO-gated. The register holds, for each
 * person, the paper they signed and every decision taken about it - so a search
 * across it is itself an exercise of power, and looking at one person's record
 * writes a `staff_viewed_principal` entry. Nobody browses this anonymously.
 */
import "server-only";
import { pool, type Executor } from "@/lib/db";
import { normaliseEmail, normalisePhone } from "@/lib/phone";
import type { ConsentStatus, IntakeMode, NoticeAtCollection } from "@/lib/consent";

export interface PrincipalMatchRow {
  id: string;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  merged_into_id: string | null;
  artifacts: number;
  active_consents: number;
  withdrawn_consents: number;
}

/**
 * Search by name, phone or email.
 *
 * A phone typed as it appears on paper ("98765 43210") has to find the E.164 row
 * it was stored as, so the query is given the normalised form as well as the raw
 * text - the same normalisers intake used, so search and storage cannot disagree
 * about what a number is.
 *
 * Merged rows are included rather than hidden: a DPO searching the register
 * needs to be able to find an absorbed identity and see where it went, which is
 * the opposite of what the portal needs.
 */
export async function searchPrincipals(
  raw: string,
  executor: Executor = pool,
): Promise<PrincipalMatchRow[]> {
  const term = raw.trim();
  if (term.length < 2) return [];

  const { rows } = await executor.query<PrincipalMatchRow>(
    `SELECT p.id,
            p.full_name,
            p.phone_e164,
            p.email,
            p.merged_into_id,
            (SELECT count(*) FROM consent_artifact a
              WHERE a.data_principal_id = p.id)::int AS artifacts,
            (SELECT count(*) FROM consent_record r
              WHERE r.data_principal_id = p.id AND r.status = 'active')::int AS active_consents,
            (SELECT count(*) FROM consent_record r
              WHERE r.data_principal_id = p.id AND r.status = 'withdrawn')::int AS withdrawn_consents
       FROM data_principal p
      WHERE p.name_key % lower(btrim($1))
         OR p.name_key ILIKE '%' || lower(btrim($1)) || '%'
         OR ($2::text IS NOT NULL AND p.phone_e164 = $2)
         OR ($3::text IS NOT NULL AND p.email = $3)
      ORDER BY similarity(p.name_key, lower(btrim($1))) DESC, p.full_name
      LIMIT 50`,
    [term, normalisePhone(term), normaliseEmail(term)],
  );
  return rows;
}

export interface PrincipalDetail {
  id: string;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  merged_into_id: string | null;
  created_at: Date;
  portal_tokens_valid_from: Date | null;
}

export interface ArtifactRow {
  id: string;
  collected_on: string | null;
  collected_on_precision: string;
  notice_at_collection: NoticeAtCollection;
  intake_mode: IntakeMode;
  collection_location: string | null;
  committed_at: Date;
  payload_hash: string;
  form_label: string | null;
  notice_code: string | null;
  notice_version: number | null;
  transcribed_by_name: string | null;
  has_evidence: boolean;
  items: { purpose_name: string; granted: boolean; verbatim_label: string }[];
}

export interface ConsentRow {
  purpose_id: string;
  purpose_name: string;
  status: ConsentStatus;
  consent_given_on: string | null;
  withdrawn_at: Date | null;
  withdrawal_channel: string | null;
  version: number;
}

export interface AuditRow {
  id: string;
  timestamp: Date;
  action: string;
  actor_type: string;
  actor_name: string | null;
  compliance_tags: string[];
  new_state: Record<string, unknown>;
  reason: string | null;
}

export async function loadPrincipal(
  id: string,
  executor: Executor = pool,
): Promise<PrincipalDetail | null> {
  const { rows } = await executor.query<PrincipalDetail>(
    `SELECT id, full_name, phone_e164, email, merged_into_id, created_at,
            portal_tokens_valid_from
       FROM data_principal WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Identities that were folded INTO this one. The other half of the chain. */
export async function loadAbsorbed(
  id: string,
  executor: Executor = pool,
): Promise<{ id: string; full_name: string }[]> {
  const { rows } = await executor.query<{ id: string; full_name: string }>(
    "SELECT id, full_name FROM data_principal WHERE merged_into_id = $1 ORDER BY full_name",
    [id],
  );
  return rows;
}

/**
 * Every artifact for this person, newest paper first, with its tick-boxes.
 *
 * Artifacts are the immutable half - what the paper said. They are never
 * rewritten to point at a merge survivor, so a merged person's evidence stays
 * attached to the identity that signed it and is read through the chain instead:
 * this spans the whole chain, so a survivor's screen shows every piece of paper
 * that is now theirs rather than only the ones they signed under this id.
 */
export async function chainMembers(
  id: string,
  executor: Executor = pool,
): Promise<string[]> {
  const { rows } = await executor.query<{ id: string }>(
    `WITH RECURSIVE chain(id, depth) AS (
       SELECT $1::uuid, 0
       UNION ALL
       SELECT p.id, c.depth + 1
         FROM data_principal p JOIN chain c ON p.merged_into_id = c.id
        WHERE c.depth < 16
     )
     SELECT DISTINCT id FROM chain`,
    [id],
  );
  return rows.map((r) => r.id);
}

export async function loadArtifacts(
  id: string,
  executor: Executor = pool,
): Promise<ArtifactRow[]> {
  const { rows } = await executor.query<ArtifactRow>(
    `SELECT a.id,
            a.collected_on,
            a.collected_on_precision,
            a.notice_at_collection,
            a.intake_mode,
            a.collection_location,
            a.committed_at,
            a.payload_hash,
            n.form_label,
            n.code    AS notice_code,
            n.version AS notice_version,
            s.full_name AS transcribed_by_name,
            a.evidence_id IS NOT NULL AS has_evidence,
            COALESCE(
              (SELECT json_agg(json_build_object(
                        'purpose_name', p.name,
                        'granted', i.granted,
                        'verbatim_label', i.verbatim_label
                      ) ORDER BY p.display_order, p.name)
                 FROM consent_artifact_item i
                 JOIN purpose p ON p.id = i.purpose_id
                WHERE i.artifact_id = a.id),
              '[]'
            ) AS items
       FROM consent_artifact a
       LEFT JOIN consent_notice n ON n.id = a.notice_id
       LEFT JOIN staff_user s     ON s.id = a.transcribed_by
      WHERE a.data_principal_id = ANY($1::uuid[])
      ORDER BY a.collected_on DESC NULLS LAST, a.committed_at DESC`,
    [await chainMembers(id)],
  );
  return rows;
}

export async function loadConsents(
  id: string,
  executor: Executor = pool,
): Promise<ConsentRow[]> {
  const { rows } = await executor.query<ConsentRow>(
    `SELECT r.purpose_id, p.name AS purpose_name, r.status, r.consent_given_on,
            r.withdrawn_at, r.withdrawal_channel, r.version
       FROM consent_record r
       JOIN purpose p ON p.id = r.purpose_id
      WHERE r.data_principal_id = $1
      ORDER BY p.display_order, p.name`,
    [id],
  );
  return rows;
}

/**
 * The full audit trail, newest first.
 *
 * Served by audit_log_principal_timestamp_idx, which has existed since migration
 * 007 for exactly this screen. actor_id is TEXT and holds a staff id, a principal
 * id or a job name depending on actor_type, so the staff join is deliberately
 * loose rather than a foreign key - audit entries must outlive the rows they
 * describe.
 */
export async function loadAuditTrail(
  id: string,
  limit = 200,
  executor: Executor = pool,
): Promise<AuditRow[]> {
  const { rows } = await executor.query<AuditRow>(
    `SELECT l.id, l."timestamp", l.action, l.actor_type, l.compliance_tags,
            l.new_state, l.reason,
            s.full_name AS actor_name
       FROM audit_log l
       LEFT JOIN staff_user s
         ON l.actor_type = 'staff' AND s.id::text = l.actor_id
      WHERE l.data_principal_id = ANY($1::uuid[])
      ORDER BY l."timestamp" DESC, l.id DESC
      LIMIT $2`,
    [await chainMembers(id), limit],
  );
  return rows;
}

/**
 * Records that a staff member looked at this person's record - once per viewing
 * session, not once per render.
 *
 * The naive version of this wrote an entry from the page component and produced
 * 115 rows in twenty minutes: React server components render on prefetch, on
 * Fast Refresh, and again on navigation, and audit_log is append-only, so the
 * noise could not be deleted afterwards. It buried the entries that matter -
 * form digitised, consent withdrawn - under a wall of view records, and an audit
 * trail nobody can read is worse than one that is slightly incomplete.
 *
 * The window collapses a session to a single entry. The write is conditional in
 * SQL rather than a read followed by an insert, because two concurrent renders
 * would both pass a separate check.
 */
const VIEW_DEDUPE_WINDOW = "30 minutes";

export async function recordPrincipalView(
  principalId: string,
  staffId: string,
  detail: Record<string, unknown>,
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_log (action, actor_type, actor_id, data_principal_id, new_state)
     SELECT 'staff_viewed_principal', 'staff', $2, $1, $3::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_log
         WHERE action = 'staff_viewed_principal'
           AND data_principal_id = $1
           AND actor_id = $2
           AND "timestamp" > now() - $4::interval
      )`,
    [principalId, staffId, JSON.stringify(detail), VIEW_DEDUPE_WINDOW],
  );
}
