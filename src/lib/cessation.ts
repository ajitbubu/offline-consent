/**
 * s.6(6) — causing processing to stop, and being able to prove it.
 *
 * Withdrawal changes `consent_record`, which is what enforcement reads. That is
 * necessary and not sufficient: the Act requires the Fiduciary to cease
 * processing and to cause its Processors to do the same, and a register that
 * cannot say which systems were told, by whom, and when is evidence of intent
 * rather than of compliance.
 *
 * So a withdrawal that actually changes something raises one task per active
 * downstream system. Tasks are rows, not messages: they are written inside the
 * same transaction as the withdrawal, because a withdrawal recorded without its
 * obligations is the gap this exists to close. Actually TELLING those systems is
 * a side effect and belongs after commit (Invariant 4) - this is the queue, not
 * the delivery.
 */
import "server-only";
import { writeAudit } from "@/lib/audit";
import { pool, query, type Executor } from "@/lib/db";

export interface CessationTaskRow {
  id: string;
  data_principal_id: string;
  principal_name: string;
  purpose_name: string;
  system_name: string;
  system_owner: string;
  raised_at: Date;
  due_at: Date;
  status: "open" | "completed" | "on_hold";
  hold_reason: string | null;
  overdue: boolean;
}

/**
 * Raises a task per active system for each purpose actually withdrawn.
 *
 * ON CONFLICT against the partial unique index, so re-withdrawing while a task
 * is still open does not duplicate it - a person insisting is not a second
 * obligation. A purpose withdrawn, re-granted on new paper and withdrawn again
 * does raise a fresh task, because by then the old one is closed.
 */
export async function raiseCessationTasks(
  principalId: string,
  purposeIds: readonly string[],
  client: Executor,
): Promise<number> {
  if (purposeIds.length === 0) return 0;

  const { rowCount } = await client.query(
    `INSERT INTO cessation_task (data_principal_id, purpose_id, system_id, due_at)
     SELECT $1, p.purpose_id, s.id, now() + (s.sla_days || ' days')::interval
       FROM unnest($2::uuid[]) AS p(purpose_id)
       CROSS JOIN downstream_system s
      WHERE s.is_active
     ON CONFLICT (data_principal_id, purpose_id, system_id)
       WHERE status = 'open'
       DO NOTHING`,
    [principalId, [...purposeIds]],
  );
  return rowCount ?? 0;
}

/** The worked queue, oldest due first. */
export async function loadTasks(
  status: "open" | "on_hold" | "completed" = "open",
  executor: Executor = pool,
): Promise<CessationTaskRow[]> {
  const { rows } = await executor.query<CessationTaskRow>(
    `SELECT t.id,
            t.data_principal_id,
            d.full_name AS principal_name,
            p.name      AS purpose_name,
            s.name      AS system_name,
            s.owner_contact AS system_owner,
            t.raised_at,
            t.due_at,
            t.status,
            t.hold_reason,
            (t.status = 'open' AND t.due_at < now()) AS overdue
       FROM cessation_task t
       JOIN data_principal d    ON d.id = t.data_principal_id
       JOIN purpose p           ON p.id = t.purpose_id
       JOIN downstream_system s ON s.id = t.system_id
      WHERE t.status = $1
      ORDER BY t.due_at
      LIMIT 300`,
    [status],
  );
  return rows;
}

export async function countOpenTasks(): Promise<{ open: number; overdue: number }> {
  const { rows } = await query<{ open: string; overdue: string }>(
    `SELECT count(*) FILTER (WHERE status = 'open')                     AS open,
            count(*) FILTER (WHERE status = 'open' AND due_at < now())  AS overdue
       FROM cessation_task`,
  );
  return { open: Number(rows[0].open), overdue: Number(rows[0].overdue) };
}

/**
 * Marks a task done. The note says what was actually stopped, because "done"
 * with no account of what was done is not evidence.
 */
export async function completeTask(
  id: string,
  staffId: string,
  note: string,
  client: Executor,
): Promise<boolean> {
  const { rows } = await client.query<{ data_principal_id: string; purpose_id: string }>(
    `UPDATE cessation_task
        SET status = 'completed', completed_at = now(), completed_by = $2,
            completion_note = $3
      WHERE id = $1 AND status <> 'completed'
      RETURNING data_principal_id, purpose_id`,
    [id, staffId, note],
  );
  if (rows.length === 0) return false;

  await writeAudit(
    {
      action: "cessation_completed",
      actorType: "staff",
      actorId: staffId,
      dataPrincipalId: rows[0].data_principal_id,
      newState: { taskId: id, purposeId: rows[0].purpose_id },
      reason: note,
      complianceTags: ["dpdp_s6_6"],
    },
    client,
  );
  return true;
}

/**
 * Puts a task on the statutory carve-out.
 *
 * s.6(6) requires cessation unless the processing is required or authorised
 * under the Act, so a hold is a legal claim about a specific system and a
 * specific purpose - not a way of clearing the queue. The reason is stored, the
 * staff member is named, and it lands in that person's audit trail where a
 * regulator would look for it.
 */
export async function holdTask(
  id: string,
  staffId: string,
  reason: string,
  client: Executor,
): Promise<boolean> {
  const { rows } = await client.query<{ data_principal_id: string; purpose_id: string }>(
    `UPDATE cessation_task
        SET status = 'on_hold', hold_reason = $3, held_by = $2
      WHERE id = $1 AND status = 'open'
      RETURNING data_principal_id, purpose_id`,
    [id, staffId, reason],
  );
  if (rows.length === 0) return false;

  await writeAudit(
    {
      action: "cessation_completed",
      actorType: "staff",
      actorId: staffId,
      dataPrincipalId: rows[0].data_principal_id,
      newState: { taskId: id, purposeId: rows[0].purpose_id, outcome: "on_hold" },
      reason,
      complianceTags: ["dpdp_s6_6"],
    },
    client,
  );
  return true;
}
