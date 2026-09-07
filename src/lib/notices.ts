/**
 * s.5(2) — the notice owed for personal data held from before commencement.
 *
 * Most pre-2023 paper carries no compliant notice. Digitising it honestly turns
 * a dormant obligation into a countable, dated one, and that is the intended
 * outcome rather than a side effect: the dashboard leads with the number so the
 * scale is visible from the first week rather than at the first Board query.
 *
 * A number nobody can work is only half of it, so this is the queue behind it.
 * Delivery is recorded in audit_log rather than a status column - the evidence
 * that a person was given their notice is exactly the sort of thing that must be
 * append-only, and `notice_delivered` has been a declared action since 007.
 */
import "server-only";
import { writeAudit } from "@/lib/audit";
import { pool, type Executor } from "@/lib/db";

export interface NoticeOwedRow {
  data_principal_id: string;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  artifacts: number;
  earliest_collected_on: string | null;
  latest_committed_at: Date;
}

/**
 * People with at least one artifact recorded as carrying no notice, who have not
 * since been sent one.
 *
 * 'unknown' counts as owed alongside 'none'. Not knowing whether a notice was
 * given is not evidence that one was, and the safe direction for a statutory
 * obligation is to owe it.
 */
export async function loadNoticeQueue(executor: Executor = pool): Promise<NoticeOwedRow[]> {
  const { rows } = await executor.query<NoticeOwedRow>(
    `SELECT a.data_principal_id,
            d.full_name,
            d.phone_e164,
            d.email,
            count(*)::int              AS artifacts,
            min(a.collected_on)::text  AS earliest_collected_on,
            max(a.committed_at)        AS latest_committed_at
       FROM consent_artifact a
       JOIN data_principal d ON d.id = a.data_principal_id
      WHERE a.notice_at_collection IN ('none', 'unknown')
        AND d.merged_into_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM audit_log l
           WHERE l.action = 'notice_delivered'
             AND l.data_principal_id = a.data_principal_id
        )
      GROUP BY a.data_principal_id, d.full_name, d.phone_e164, d.email
      ORDER BY min(a.collected_on) NULLS FIRST
      LIMIT 300`,
  );
  return rows;
}

export async function countNoticesOwed(executor: Executor = pool): Promise<number> {
  const { rows } = await executor.query<{ n: string }>(
    `SELECT count(DISTINCT a.data_principal_id) AS n
       FROM consent_artifact a
       JOIN data_principal d ON d.id = a.data_principal_id
      WHERE a.notice_at_collection IN ('none', 'unknown')
        AND d.merged_into_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM audit_log l
           WHERE l.action = 'notice_delivered' AND l.data_principal_id = a.data_principal_id
        )`,
  );
  return Number(rows[0].n);
}

/**
 * Records that a person was given their notice.
 *
 * The channel and the note are stored because "delivered" with no account of how
 * is not evidence a regulator can check. There is no undo: this is an audit
 * entry, and the table refuses UPDATE and DELETE by trigger.
 */
export async function recordNoticeDelivered(
  input: {
    principalId: string;
    staffId: string;
    channel: "post" | "email" | "sms" | "in_person";
    note: string;
    noticeId?: string | null;
  },
  client: Executor,
): Promise<void> {
  await writeAudit(
    {
      action: "notice_delivered",
      actorType: "staff",
      actorId: input.staffId,
      dataPrincipalId: input.principalId,
      newState: { channel: input.channel, noticeId: input.noticeId ?? null },
      reason: input.note,
      complianceTags: ["dpdp_s5_2"],
    },
    client,
  );
}
