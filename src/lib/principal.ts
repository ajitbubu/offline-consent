/**
 * Identity resolution across a merge.
 *
 * `data_principal.merged_into_id` is set when a DPO folds a duplicate person
 * into another. Consent artifacts are never rewritten to point at the survivor,
 * because an artifact records what one piece of paper said and that does not
 * change - so every read has to follow the chain instead, exactly as the column
 * comment in migration 001 says.
 *
 *     A --merged_into--> B --merged_into--> C
 *     resolve(A) = C     resolve(B) = C      resolve(C) = C
 *
 * Getting this wrong in either direction is bad in a specific way: not
 * following the chain strands a person's consents behind a dead identity that
 * their withdrawal token can no longer reach, and following it too eagerly on a
 * WRITE would fuse two people's consent state, which is the thing Invariant 11
 * exists to prevent. Reads follow. Matching (intake.ts) still refuses to
 * consider merged rows at all.
 */
import "server-only";
import { pool, type Executor } from "@/lib/db";

/** Guards against a cycle, which nothing in the schema prevents. */
const MAX_MERGE_DEPTH = 16;

/**
 * The surviving identity for `id`, or null if there is no such person or the
 * chain does not terminate.
 */
export async function resolvePrincipalId(
  id: string,
  executor: Executor = pool,
): Promise<string | null> {
  const { rows } = await executor.query<{ id: string }>(
    `WITH RECURSIVE chain(id, merged_into_id, depth) AS (
       SELECT id, merged_into_id, 0
         FROM data_principal
        WHERE id = $1
       UNION ALL
       SELECT p.id, p.merged_into_id, chain.depth + 1
         FROM data_principal p
         JOIN chain ON p.id = chain.merged_into_id
        WHERE chain.depth < $2
     )
     SELECT id FROM chain WHERE merged_into_id IS NULL LIMIT 1`,
    [id, MAX_MERGE_DEPTH],
  );
  return rows[0]?.id ?? null;
}
