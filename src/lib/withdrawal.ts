/**
 * Withdrawal of consent (DPDP s.6(4)-(6)).
 *
 * Three things this deliberately does NOT do:
 *
 *  - It does not delete anything. Withdrawal is not erasure. s.6(5) says
 *    withdrawal has no effect on the lawfulness of processing already carried
 *    out, and the consent artifact stays untouched because it is the proof that
 *    consent was validly obtained in the first place.
 *  - It does not fail when the consent is already withdrawn. A repeated request
 *    is a person insisting, not an error.
 *  - It does not report success it did not achieve. Every branch returns an
 *    outcome and writes an audit entry, including the one where there is no
 *    record to withdraw, and the portal renders what came back rather than
 *    assuming a 200 meant something changed.
 *  - It does not let a withdrawal be undone here. Re-granting consent requires a
 *    new artifact, which means new paper.
 */
import "server-only";
import { writeAudit } from "@/lib/audit";
import type { Executor } from "@/lib/db";
import type { WithdrawalChannel } from "@/lib/consent";

export interface WithdrawOutcome {
  purposeId: string;
  status: "withdrawn" | "declined" | "not_found";
  changed: boolean;
  withdrawnOn: string | null;
}

export async function withdrawPurposes(
  input: {
    principalId: string;
    purposeIds: readonly string[];
    channel: WithdrawalChannel;
    reason?: string | null;
    actorType: "data_principal" | "staff";
    actorId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  client: Executor,
): Promise<WithdrawOutcome[]> {
  const outcomes: WithdrawOutcome[] = [];

  for (const purposeId of input.purposeIds) {
    const { rows } = await client.query<{
      id: string;
      status: string;
      withdrawn_at: Date | null;
    }>(
      `SELECT id, status, withdrawn_at
         FROM consent_record
        WHERE data_principal_id = $1 AND purpose_id = $2
        FOR UPDATE`,
      [input.principalId, purposeId],
    );

    const record = rows[0];
    if (!record) {
      // No record for this (person, purpose). Audited like every other branch:
      // a person exercising s.6(4) against something we cannot find is exactly
      // the case where the evidence that they ASKED matters most, and it is
      // also the signal that they have a second identity in the register whose
      // consents this token cannot reach.
      await writeAudit(
        {
          action: "consent_withdrawn",
          actorType: input.actorType,
          actorId: input.actorId,
          dataPrincipalId: input.principalId,
          newState: { purposeId, channel: input.channel, outcome: "not_found" },
          reason: input.reason ?? null,
          complianceTags: ["dpdp_s6_4"],
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
        client,
      );
      outcomes.push({ purposeId, status: "not_found", changed: false, withdrawnOn: null });
      continue;
    }

    if (record.status === "declined") {
      outcomes.push({ purposeId, status: "declined", changed: false, withdrawnOn: null });
      continue;
    }

    if (record.status === "withdrawn") {
      // Already done, so nothing changes - but the request is still recorded.
      // A person asking twice may be telling us the first one was not honoured
      // downstream, and that belongs in the evidence.
      await writeAudit(
        {
          action: "withdrawal_reaffirmed",
          actorType: input.actorType,
          actorId: input.actorId,
          dataPrincipalId: input.principalId,
          newState: { purposeId, channel: input.channel },
          complianceTags: ["dpdp_s6_4"],
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
        client,
      );
      outcomes.push({
        purposeId,
        status: "withdrawn",
        changed: false,
        withdrawnOn: record.withdrawn_at?.toISOString() ?? null,
      });
      continue;
    }

    const { rows: updated } = await client.query<{ withdrawn_at: Date }>(
      `UPDATE consent_record
          SET status = 'withdrawn',
              withdrawn_at = now(),
              withdrawal_channel = $2,
              withdrawal_reason = $3,
              version = version + 1
        WHERE id = $1
      RETURNING withdrawn_at`,
      [record.id, input.channel, input.reason ?? null],
    );

    await writeAudit(
      {
        action: "consent_withdrawn",
        actorType: input.actorType,
        actorId: input.actorId,
        dataPrincipalId: input.principalId,
        previousState: { status: record.status },
        newState: { status: "withdrawn", purposeId, channel: input.channel },
        reason: input.reason ?? null,
        // s.6(4) is the right being exercised; s.6(6) is the obligation it
        // creates to stop processing, including by our processors.
        complianceTags: ["dpdp_s6_4", "dpdp_s6_6"],
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      client,
    );

    outcomes.push({
      purposeId,
      status: "withdrawn",
      changed: true,
      withdrawnOn: updated[0].withdrawn_at.toISOString(),
    });
  }

  return outcomes;
}
