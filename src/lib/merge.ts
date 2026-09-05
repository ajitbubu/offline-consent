/**
 * Folding one duplicate identity into another (Phase 7).
 *
 * Invariant 11: duplicate people are NEVER merged automatically, because fusing
 * two real people leaks one person's consent state into another's. This function
 * is therefore only ever reached from an explicit DPO action on a named pair,
 * and it takes the staff id that asked for it.
 *
 * What a merge does and does not touch:
 *
 *   consent_artifact      untouched. An artifact records what one piece of paper
 *                         said, and that does not change because we later decided
 *                         two records were one person. Reads follow the chain.
 *   consent_record        moved onto the survivor, reconciled per purpose below.
 *                         This is the mutable projection; there is one row per
 *                         (person, purpose) by constraint, so the two sides have
 *                         to be resolved rather than both kept.
 *   data_principal        the absorbed row stays, with merged_into_id set. It is
 *                         never deleted: audit entries and artifacts point at it,
 *                         and the contact point on it must keep working.
 *
 * The reconciliation rule, in one line: a withdrawal never loses.
 */
import "server-only";
import { writeAudit } from "@/lib/audit";
import type { Executor } from "@/lib/db";
import { resolvePrincipalId } from "@/lib/principal";

export type MergeErrorCode =
  | "same_person"
  | "not_found"
  | "already_merged"
  | "would_cycle";

export class MergeError extends Error {
  constructor(
    readonly code: MergeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MergeError";
  }
}

interface RecordRow {
  id: string;
  purpose_id: string;
  status: string;
  consent_given_on: string | null;
  withdrawn_at: Date | null;
  withdrawal_channel: string | null;
  withdrawal_reason: string | null;
  source_artifact_id: string;
}

export interface MergeResult {
  survivorId: string;
  absorbedId: string;
  recordsMoved: number;
  recordsReconciled: number;
  /** Purposes where the absorbed side's answer won, and why. */
  decisions: { purposeId: string; winner: "absorbed" | "survivor"; reason: string }[];
}

/**
 * Which of two records for the same purpose survives.
 *
 * A withdrawal never loses. If either side was withdrawn, the merged record is
 * withdrawn - merging is a human asserting these are one person, and if that
 * person ever said stop for this purpose then processing must not continue
 * because the other half of their identity had never said it. The earliest
 * withdrawal wins, because that is when processing should have stopped.
 *
 * Otherwise the later signature wins, and an undated record never beats a dated
 * one - the same rule commitDraft applies, for the same reason: an undated form
 * cannot be shown to be later than anything.
 */
function winner(survivor: RecordRow, absorbed: RecordRow): { row: RecordRow; reason: string } {
  const sw = survivor.status === "withdrawn";
  const aw = absorbed.status === "withdrawn";

  if (sw && aw) {
    const earliest =
      (absorbed.withdrawn_at?.getTime() ?? Infinity) < (survivor.withdrawn_at?.getTime() ?? Infinity)
        ? absorbed
        : survivor;
    return { row: earliest, reason: "both withdrawn; earliest withdrawal kept" };
  }
  if (aw) return { row: absorbed, reason: "absorbed side was withdrawn; a withdrawal never loses" };
  if (sw) return { row: survivor, reason: "survivor was withdrawn; a withdrawal never loses" };

  const a = absorbed.consent_given_on;
  const s = survivor.consent_given_on;
  if (a !== null && s !== null) {
    return a > s
      ? { row: absorbed, reason: "absorbed side carries the later signature" }
      : { row: survivor, reason: "survivor carries the later or equal signature" };
  }
  if (a !== null && s === null) {
    return { row: absorbed, reason: "survivor's record is undated and cannot be shown to be later" };
  }
  // Survivor dated and absorbed undated, or both undated: the survivor stands.
  return { row: survivor, reason: "survivor stands; the absorbed record is undated" };
}

/**
 * Merges `absorbedId` into `survivorId`. Caller supplies the transaction.
 */
export async function mergePrincipals(
  input: {
    absorbedId: string;
    survivorId: string;
    staffId: string;
    reason: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  client: Executor,
): Promise<MergeResult> {
  const { absorbedId, survivorId, staffId, reason } = input;

  if (absorbedId === survivorId) {
    throw new MergeError("same_person", "A record cannot be merged into itself");
  }

  const { rows: people } = await client.query<{ id: string; merged_into_id: string | null }>(
    "SELECT id, merged_into_id FROM data_principal WHERE id = ANY($1::uuid[]) FOR UPDATE",
    [[absorbedId, survivorId]],
  );
  if (people.length !== 2) throw new MergeError("not_found", "One of those records no longer exists");

  const absorbed = people.find((p) => p.id === absorbedId)!;
  if (absorbed.merged_into_id !== null) {
    throw new MergeError("already_merged", "That record has already been merged into another");
  }

  // The survivor must not resolve back through the absorbed record, or the chain
  // becomes a cycle and resolvePrincipalId returns nobody.
  const survivorResolves = await resolvePrincipalId(survivorId, client);
  if (survivorResolves === null || survivorResolves === absorbedId) {
    throw new MergeError("would_cycle", "That merge would leave the two records pointing at each other");
  }

  const columns = `id, purpose_id, status, consent_given_on, withdrawn_at,
                   withdrawal_channel, withdrawal_reason, source_artifact_id`;
  const { rows: absorbedRecords } = await client.query<RecordRow>(
    `SELECT ${columns} FROM consent_record WHERE data_principal_id = $1 FOR UPDATE`,
    [absorbedId],
  );
  const { rows: survivorRecords } = await client.query<RecordRow>(
    `SELECT ${columns} FROM consent_record WHERE data_principal_id = $1 FOR UPDATE`,
    [survivorId],
  );
  const bySurvivorPurpose = new Map(survivorRecords.map((r) => [r.purpose_id, r]));

  const decisions: MergeResult["decisions"] = [];
  let recordsMoved = 0;
  let recordsReconciled = 0;

  for (const record of absorbedRecords) {
    const rival = bySurvivorPurpose.get(record.purpose_id);

    if (!rival) {
      // The survivor has no answer for this purpose, so the absorbed row simply
      // becomes theirs. Nothing is decided and nothing is lost.
      await client.query(
        "UPDATE consent_record SET data_principal_id = $2, version = version + 1 WHERE id = $1",
        [record.id, survivorId],
      );
      recordsMoved += 1;
      continue;
    }

    const { row: keep, reason: why } = winner(rival, record);
    decisions.push({
      purposeId: record.purpose_id,
      winner: keep.id === record.id ? "absorbed" : "survivor",
      reason: why,
    });

    if (keep.id === record.id) {
      await client.query(
        `UPDATE consent_record
            SET status = $2, consent_given_on = $3, withdrawn_at = $4,
                withdrawal_channel = $5, withdrawal_reason = $6,
                source_artifact_id = $7, version = version + 1
          WHERE id = $1`,
        [
          rival.id,
          keep.status,
          keep.consent_given_on,
          keep.withdrawn_at,
          keep.withdrawal_channel,
          keep.withdrawal_reason,
          keep.source_artifact_id,
        ],
      );
    }

    // One row per (person, purpose) by constraint, so the losing row goes. What
    // it said is not lost: it is in the audit entry below and in the artifact it
    // came from, which is never touched.
    await client.query("DELETE FROM consent_record WHERE id = $1", [record.id]);
    recordsReconciled += 1;
  }

  await client.query("UPDATE data_principal SET merged_into_id = $2 WHERE id = $1", [
    absorbedId,
    survivorId,
  ]);

  await writeAudit(
    {
      action: "principals_merged",
      actorType: "staff",
      actorId: staffId,
      dataPrincipalId: survivorId,
      previousState: {
        absorbedRecords: absorbedRecords.map((r) => ({
          purposeId: r.purpose_id,
          status: r.status,
          consentGivenOn: r.consent_given_on,
        })),
      },
      newState: { absorbedId, survivorId, recordsMoved, recordsReconciled, decisions },
      reason,
      complianceTags: ["dpdp_s6_1"],
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    client,
  );

  // Written against the absorbed id too, so the merge is visible from either
  // side of the chain rather than only from the survivor's screen.
  await writeAudit(
    {
      action: "principals_merged",
      actorType: "staff",
      actorId: staffId,
      dataPrincipalId: absorbedId,
      newState: { mergedInto: survivorId, recordsMoved, recordsReconciled },
      reason,
      complianceTags: ["dpdp_s6_1"],
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    client,
  );

  return { survivorId, absorbedId, recordsMoved, recordsReconciled, decisions };
}
