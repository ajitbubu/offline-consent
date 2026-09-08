import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { commitDraft } from "@/lib/intake";
import { withdrawPurposes } from "@/lib/withdrawal";
import { insertDraft, seedFixture, withRollback, type Fixture } from "./helpers/db";

/** A committed form, so there are real consent_record rows to withdraw. */
async function givenConsent(client: PoolClient, fx: Fixture, granted?: boolean[]) {
  const draftId = await insertDraft(client, fx, { collectedOn: "2019-03-04", granted });
  return commitDraft({ draftId, staffId: fx.staffId }, client);
}

async function auditFor(client: PoolClient, principalId: string) {
  const { rows } = await client.query<{ action: string; new_state: Record<string, unknown> }>(
    `SELECT action, new_state FROM audit_log
      WHERE data_principal_id = $1 ORDER BY id`,
    [principalId],
  );
  return rows;
}

describe("withdrawPurposes", () => {
  it("withdraws an active consent, and records it as evidence in the same breath", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { dataPrincipalId } = await givenConsent(client, fx);

      const outcomes = await withdrawPurposes(
        {
          principalId: dataPrincipalId,
          purposeIds: [fx.purposeIds[0]],
          channel: "portal",
          actorType: "data_principal",
          actorId: dataPrincipalId,
        },
        client,
      );

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ status: "withdrawn", changed: true });
      expect(outcomes[0].withdrawnOn).not.toBeNull();

      const { rows } = await client.query<{ status: string; withdrawal_channel: string; version: number }>(
        "SELECT status, withdrawal_channel, version FROM consent_record WHERE data_principal_id = $1 AND purpose_id = $2",
        [dataPrincipalId, fx.purposeIds[0]],
      );
      expect(rows[0].status).toBe("withdrawn");
      expect(rows[0].withdrawal_channel).toBe("portal");
      expect(rows[0].version).toBe(2);

      const audit = await auditFor(client, dataPrincipalId);
      const entry = audit.find((a) => a.action === "consent_withdrawn");
      expect(entry).toBeDefined();
      const { rows: tagged } = await client.query<{ compliance_tags: string[] }>(
        "SELECT compliance_tags FROM audit_log WHERE action = 'consent_withdrawn' AND data_principal_id = $1",
        [dataPrincipalId],
      );
      // s.6(4) is the right exercised; s.6(6) is the duty it creates to stop.
      expect(tagged[0].compliance_tags).toEqual(
        expect.arrayContaining(["dpdp_s6_4", "dpdp_s6_6"]),
      );
    });
  });

  it("treats asking twice as insisting, not as an error", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { dataPrincipalId } = await givenConsent(client, fx);
      const args = {
        principalId: dataPrincipalId,
        purposeIds: [fx.purposeIds[0]],
        channel: "portal" as const,
        actorType: "data_principal" as const,
        actorId: dataPrincipalId,
      };

      await withdrawPurposes(args, client);
      const second = await withdrawPurposes(args, client);

      expect(second[0]).toMatchObject({ status: "withdrawn", changed: false });
      // The second request changed nothing, but it is still evidence: a person
      // asking again may be telling us the first one was not honoured.
      const audit = await auditFor(client, dataPrincipalId);
      expect(audit.filter((a) => a.action === "withdrawal_reaffirmed")).toHaveLength(1);
    });
  });

  it("leaves a consent that was never given alone", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { dataPrincipalId } = await givenConsent(client, fx, [false, true, true]);

      const outcomes = await withdrawPurposes(
        {
          principalId: dataPrincipalId,
          purposeIds: [fx.purposeIds[0]],
          channel: "portal",
          actorType: "data_principal",
          actorId: dataPrincipalId,
        },
        client,
      );

      expect(outcomes[0]).toMatchObject({ status: "declined", changed: false });
      const { rows } = await client.query<{ status: string }>(
        "SELECT status FROM consent_record WHERE data_principal_id = $1 AND purpose_id = $2",
        [dataPrincipalId, fx.purposeIds[0]],
      );
      expect(rows[0].status).toBe("declined");
    });
  });

  it("audits a withdrawal request it cannot fulfil, instead of failing silently", async () => {
    // REGRESSION (T13). not_found was the one branch that returned an outcome
    // and wrote nothing, and the portal reported any 200 as success - so a
    // person could be told their consent was withdrawn with no record anywhere
    // that they had ever asked. This is usually the symptom of a second
    // identity in the register that this contact point cannot reach.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { dataPrincipalId } = await givenConsent(client, fx);

      const { rows: other } = await client.query<{ id: string }>(
        "INSERT INTO purpose (code, name, description, display_order) VALUES ($1,$2,$3,$4) RETURNING id",
        [`orphan-${Math.random().toString(36).slice(2, 10)}`, "Unheld purpose", "d", 9],
      );

      const outcomes = await withdrawPurposes(
        {
          principalId: dataPrincipalId,
          purposeIds: [other[0].id],
          channel: "portal",
          actorType: "data_principal",
          actorId: dataPrincipalId,
        },
        client,
      );

      expect(outcomes[0]).toMatchObject({ status: "not_found", changed: false });

      const audit = await auditFor(client, dataPrincipalId);
      const entry = audit.find((a) => a.new_state?.outcome === "not_found");
      expect(entry, "a request we could not fulfil must still be evidence").toBeDefined();
      expect(entry!.action).toBe("consent_withdrawn");
    });
  });

  it("reports each purpose separately when one succeeds and another cannot", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { dataPrincipalId } = await givenConsent(client, fx);
      const { rows: other } = await client.query<{ id: string }>(
        "INSERT INTO purpose (code, name, description, display_order) VALUES ($1,$2,$3,$4) RETURNING id",
        [`orphan-${Math.random().toString(36).slice(2, 10)}`, "Unheld purpose", "d", 9],
      );

      const outcomes = await withdrawPurposes(
        {
          principalId: dataPrincipalId,
          purposeIds: [fx.purposeIds[0], other[0].id],
          channel: "portal",
          actorType: "data_principal",
          actorId: dataPrincipalId,
        },
        client,
      );

      // The portal renders this array; a partial result must stay legible as one.
      expect(outcomes.map((o) => o.status)).toEqual(["withdrawn", "not_found"]);
      expect(outcomes.filter((o) => o.changed)).toHaveLength(1);
    });
  });
});
