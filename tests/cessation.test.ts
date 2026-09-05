import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { commitDraft } from "@/lib/intake";
import { withdrawPurposes } from "@/lib/withdrawal";
import { completeTask, holdTask, raiseCessationTasks } from "@/lib/cessation";
import { insertDraft, seedFixture, withRollback, type Fixture } from "./helpers/db";

async function systems(client: PoolClient, n = 2) {
  const ids: string[] = [];
  const suffix = Math.random().toString(36).slice(2, 8);
  for (let i = 0; i < n; i += 1) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO downstream_system (code, name, owner_contact, sla_days)
       VALUES ($1, $2, 'owner@example.org', $3) RETURNING id`,
      [`sys-${suffix}-${i}`, `System ${i}`, i === 0 ? 3 : 14],
    );
    ids.push(rows[0].id);
  }
  return ids;
}

async function person(client: PoolClient, fx: Fixture) {
  const result = await commitDraft(
    { draftId: await insertDraft(client, fx, { phone: "9876500201" }), staffId: fx.staffId },
    client,
  );
  return result.dataPrincipalId;
}

const withdraw = (client: PoolClient, principalId: string, purposeIds: string[]) =>
  withdrawPurposes(
    {
      principalId,
      purposeIds,
      channel: "portal",
      actorType: "data_principal",
      actorId: principalId,
    },
    client,
  );

const openTasks = async (client: PoolClient, principalId: string) => {
  const { rows } = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM cessation_task WHERE data_principal_id = $1 AND status = 'open'",
    [principalId],
  );
  return Number(rows[0].n);
};

describe("cessation tasks (s.6(6))", () => {
  it("raises one task per active system for each purpose actually withdrawn", async () => {
    // Changing our own row is necessary and not sufficient: the Act requires
    // causing processors to stop too, and that has to be a worked queue.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await systems(client, 2);
      const principalId = await person(client, fx);

      await withdraw(client, principalId, [fx.purposeIds[0], fx.purposeIds[1]]);

      // 2 purposes x 2 systems. Other systems may exist from the seed, so this
      // asserts the shape rather than a global count.
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(DISTINCT purpose_id) AS n FROM cessation_task
          WHERE data_principal_id = $1 AND status = 'open'`,
        [principalId],
      );
      expect(Number(rows[0].n)).toBe(2);
      expect(await openTasks(client, principalId)).toBeGreaterThanOrEqual(4);
    });
  });

  it("raises nothing when the withdrawal changed nothing", async () => {
    // A person insisting is recorded, but it is not a second obligation.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await systems(client, 1);
      const principalId = await person(client, fx);

      await withdraw(client, principalId, [fx.purposeIds[0]]);
      const afterFirst = await openTasks(client, principalId);

      await withdraw(client, principalId, [fx.purposeIds[0]]);
      expect(await openTasks(client, principalId)).toBe(afterFirst);
    });
  });

  it("does not raise a task for a purpose that was never given", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await systems(client, 1);
      const result = await commitDraft(
        {
          draftId: await insertDraft(client, fx, {
            phone: "9876500202",
            granted: [false, true, true],
          }),
          staffId: fx.staffId,
        },
        client,
      );

      await withdraw(client, result.dataPrincipalId, [fx.purposeIds[0]]);

      // 'declined' is not a withdrawal, so nothing was stopped and nothing is owed.
      expect(await openTasks(client, result.dataPrincipalId)).toBe(0);
    });
  });

  it("skips systems that have been retired", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const [live, retired] = await systems(client, 2);
      await client.query("UPDATE downstream_system SET is_active = false WHERE id = $1", [retired]);
      await client.query("UPDATE downstream_system SET is_active = false WHERE id <> $1", [live]);
      const principalId = await person(client, fx);

      await withdraw(client, principalId, [fx.purposeIds[0]]);

      const { rows } = await client.query<{ system_id: string }>(
        "SELECT system_id FROM cessation_task WHERE data_principal_id = $1",
        [principalId],
      );
      expect(rows.map((r) => r.system_id)).toEqual([live]);
    });
  });

  it("gives each system its own due date from its own SLA", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const [fast, slow] = await systems(client, 2);
      await client.query("UPDATE downstream_system SET is_active = false WHERE id NOT IN ($1,$2)", [fast, slow]);
      const principalId = await person(client, fx);

      await withdraw(client, principalId, [fx.purposeIds[0]]);

      const { rows } = await client.query<{ system_id: string; days: string }>(
        `SELECT system_id, round(extract(epoch FROM (due_at - raised_at)) / 86400) AS days
           FROM cessation_task WHERE data_principal_id = $1`,
        [principalId],
      );
      const byId = Object.fromEntries(rows.map((r) => [r.system_id, Number(r.days)]));
      // A nightly batch and a live API are not the same promise.
      expect(byId[fast]).toBe(3);
      expect(byId[slow]).toBe(14);
    });
  });

  it("completes a task with an account of what was stopped", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await systems(client, 1);
      const principalId = await person(client, fx);
      await withdraw(client, principalId, [fx.purposeIds[0]]);

      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM cessation_task WHERE data_principal_id = $1 LIMIT 1",
        [principalId],
      );
      const done = await completeTask(rows[0].id, fx.staffId, "Suppression list updated", client);
      expect(done).toBe(true);

      const { rows: audit } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE action = 'cessation_completed' AND data_principal_id = $1
            AND compliance_tags @> ARRAY['dpdp_s6_6']::text[]`,
        [principalId],
      );
      expect(Number(audit[0].n)).toBe(1);

      // Completing twice is not two cessations.
      expect(await completeTask(rows[0].id, fx.staffId, "again", client)).toBe(false);
    });
  });

  it("refuses a hold with no stated legal basis", async () => {
    // s.6(6) allows processing to continue only where the Act requires or
    // authorises it, so a hold is a legal claim. The database enforces that the
    // claim is written down.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await systems(client, 1);
      const principalId = await person(client, fx);
      await withdraw(client, principalId, [fx.purposeIds[0]]);
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM cessation_task WHERE data_principal_id = $1 LIMIT 1",
        [principalId],
      );

      // A failed statement aborts the whole transaction in Postgres, and
      // withRollback puts every test in one - so the expected violation needs a
      // savepoint or nothing after it can run.
      await client.query("SAVEPOINT before_bad_hold");
      await expect(
        client.query("UPDATE cessation_task SET status = 'on_hold' WHERE id = $1", [rows[0].id]),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT before_bad_hold");

      expect(
        await holdTask(rows[0].id, fx.staffId, "Retained under s.8(7) for tax records", client),
      ).toBe(true);
    });
  });

  it("does not duplicate an open task if one is raised again", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await systems(client, 1);
      const principalId = await person(client, fx);
      await withdraw(client, principalId, [fx.purposeIds[0]]);
      const before = await openTasks(client, principalId);

      await raiseCessationTasks(principalId, [fx.purposeIds[0]], client);
      expect(await openTasks(client, principalId)).toBe(before);
    });
  });
});
