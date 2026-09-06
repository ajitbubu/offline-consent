/**
 * Finding people the register is holding twice.
 *
 * Merge exists; nothing surfaced what to merge. That gap is structural rather
 * than accidental, and it comes straight out of the uniqueness rule: identity is
 * (contact point, normalised name), NOT contact point alone, because a shared
 * household or workplace number is ordinary in India and making phone globally
 * unique would either fuse two real people or block the second person's form
 * from ever being digitised.
 *
 * The consequence is that one human becomes two rows whenever:
 *
 *   - one form carries a phone and another carries an email, so neither matches
 *     the other's index and nothing links them at all; or
 *   - the name is transcribed as a variant that a reviewer waved past.
 *
 * And the portal only ever resolves one contact point, so the second identity's
 * consents are invisible and cannot be withdrawn.
 *
 * THE HARD PART is that a shared phone with different names is the legitimate
 * case the schema was designed for. A report that flags every household as a
 * duplicate is worse than no report: it trains a DPO to dismiss the list, and
 * merging two real people is the one mistake Invariant 11 exists to prevent and
 * that nothing can undo. So a shared contact point on its own is never presented
 * as a duplicate - it needs a name that looks like the same person written
 * twice.
 */
import "server-only";
import { pool, type Executor } from "@/lib/db";

/** Below this, two names are two people. Tuned against the fuzzy-match gate in commitDraft. */
const NAME_SIMILAR = 0.55;
/** Above this, a name difference is a transcription variant rather than a different person. */
const NAME_STRONG = 0.8;

export type DuplicateReason = "same_contact_similar_name" | "similar_name_split_contact";

export interface DuplicatePair {
  a_id: string;
  a_name: string;
  a_contact: string | null;
  a_artifacts: number;
  b_id: string;
  b_name: string;
  b_contact: string | null;
  b_artifacts: number;
  similarity: number;
  reason: DuplicateReason;
  shares_contact: boolean;
}

/**
 * Candidate pairs, strongest first. Never merges anything; a human decides.
 *
 * Both halves of the join are restricted to unmerged rows, and `a.id < b.id`
 * keeps each pair once rather than twice. The name comparison uses the trigram
 * operator so the GIN index on name_key does the work, rather than scanning the
 * register squared.
 */
export async function findDuplicates(
  executor: Executor = pool,
  limit = 100,
): Promise<DuplicatePair[]> {
  const { rows } = await executor.query<DuplicatePair>(
    `SELECT a.id   AS a_id,
            a.full_name AS a_name,
            COALESCE(a.phone_e164, a.email) AS a_contact,
            (SELECT count(*) FROM consent_artifact x WHERE x.data_principal_id = a.id)::int AS a_artifacts,
            b.id   AS b_id,
            b.full_name AS b_name,
            COALESCE(b.phone_e164, b.email) AS b_contact,
            (SELECT count(*) FROM consent_artifact y WHERE y.data_principal_id = b.id)::int AS b_artifacts,
            round(similarity(a.name_key, b.name_key)::numeric, 3)::float8 AS similarity,
            -- COALESCE, because SQL is three-valued and this is exactly where
            -- that bites: in the split case (one row has only a phone, the other
            -- only an email) the phone comparison is NULL rather than false, and
            -- NULL OR false is NULL. The column then arrives in TypeScript as
            -- null, which is neither of the two states the caller reasons about.
            (   COALESCE(a.phone_e164 = b.phone_e164, false)
             OR COALESCE(a.email      = b.email,      false)) AS shares_contact,
            CASE
              WHEN COALESCE(a.phone_e164 = b.phone_e164, false)
                OR COALESCE(a.email      = b.email,      false)
              THEN 'same_contact_similar_name'
              ELSE 'similar_name_split_contact'
            END AS reason
       FROM data_principal a
       JOIN data_principal b
         ON a.id < b.id
        AND a.name_key % b.name_key
      WHERE a.merged_into_id IS NULL
        AND b.merged_into_id IS NULL
        -- A shared contact point alone is a household, not a duplicate. What
        -- makes a pair worth a DPO's attention is the NAME looking like one
        -- person written twice.
        AND similarity(a.name_key, b.name_key) >= $1
        -- Identical names on the same contact point cannot happen: that is the
        -- unique index, so anything reaching here is already a real difference.
        AND a.name_key <> b.name_key
      ORDER BY similarity(a.name_key, b.name_key) DESC, a.full_name
      LIMIT $2`,
    [NAME_SIMILAR, limit],
  );
  return rows;
}

export async function countDuplicates(executor: Executor = pool): Promise<number> {
  const { rows } = await executor.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM data_principal a
       JOIN data_principal b ON a.id < b.id AND a.name_key % b.name_key
      WHERE a.merged_into_id IS NULL AND b.merged_into_id IS NULL
        AND similarity(a.name_key, b.name_key) >= $1
        AND a.name_key <> b.name_key`,
    [NAME_SIMILAR],
  );
  return Number(rows[0].n);
}

/** How sure we are, in words a DPO can act on rather than a number. */
export function confidenceOf(pair: DuplicatePair): {
  label: string;
  tone: "red" | "amber" | "neutral";
  note: string;
} {
  if (pair.shares_contact && pair.similarity >= NAME_STRONG) {
    return {
      label: "Very likely the same person",
      tone: "red",
      note: "Same contact point, and the names differ only as a transcription would.",
    };
  }
  if (pair.shares_contact) {
    return {
      label: "Could be a household",
      tone: "neutral",
      note: "They share a contact point, but the names are different enough to be two people. A shared number is ordinary; check the paper before merging.",
    };
  }
  return {
    label: "Possible, split across contact points",
    tone: "amber",
    note: "Close names with no contact point in common — the case where one form carried a phone and another an email, so nothing links them.",
  };
}
