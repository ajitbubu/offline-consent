import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { commitDraft } from "@/lib/intake";
import { requestOtp, verifyOtp } from "@/lib/otp";
import { MergeError, mergePrincipals } from "@/lib/merge";
import { resolvePrincipalId } from "@/lib/principal";
import { insertDraft, seedFixture, withRollback, type Fixture } from "./helpers/db";

/** Two committed people, each with their own artifact and three records. */
async function twoPeople(client: PoolClient, fx: Fixture) {
  const a = await commitDraft(
    {
      draftId: await insertDraft(client, fx, {
        fullName: "Anita Desai",
        phone: "9876500101",
        collectedOn: "2019-03-04",
      }),
      staffId: fx.staffId,
    },
    client,
  );
  const b = await commitDraft(
    {
      draftId: await insertDraft(client, fx, {
        fullName: "Anita R Desai",
        phone: "9876500102",
        collectedOn: "2021-07-07",
      }),
      staffId: fx.staffId,
    },
    client,
  );
  return { absorbed: a.dataPrincipalId, survivor: b.dataPrincipalId };
}

const setRecord = (
  client: PoolClient,
  principalId: string,
  purposeId: string,
  patch: { status: string; givenOn?: string | null; withdrawnAt?: string | null },
) =>
  client.query(
    `UPDATE consent_record
        SET status = $3,
            consent_given_on = COALESCE($4::date, consent_given_on),
            withdrawn_at = $5::timestamptz
      WHERE data_principal_id = $1 AND purpose_id = $2`,
    [principalId, purposeId, patch.status, patch.givenOn ?? null, patch.withdrawnAt ?? null],
  );

const statusOf = async (client: PoolClient, principalId: string, purposeId: string) => {
  const { rows } = await client.query<{ status: string; consent_given_on: string | null }>(
    "SELECT status, consent_given_on FROM consent_record WHERE data_principal_id = $1 AND purpose_id = $2",
    [principalId, purposeId],
  );
  return rows[0] ?? null;
};

const merge = (client: PoolClient, absorbedId: string, survivorId: string, staffId: string) =>
  mergePrincipals(
    { absorbedId, survivorId, staffId, reason: "Same person, confirmed against the paper" },
    client,
  );

describe("mergePrincipals", () => {
  it("points the absorbed identity at the survivor without deleting it", async () => {
    // The absorbed row is never removed: artifacts and audit entries point at
    // it, and the contact point on it has to keep working at the portal.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);

      await merge(client, absorbed, survivor, fx.staffId);

      const { rows } = await client.query<{ merged_into_id: string | null }>(
        "SELECT merged_into_id FROM data_principal WHERE id = $1",
        [absorbed],
      );
      expect(rows[0].merged_into_id).toBe(survivor);
      await expect(resolvePrincipalId(absorbed, client)).resolves.toBe(survivor);
    });
  });

  it("leaves every artifact attached to the identity that signed it", async () => {
    // An artifact records what one piece of paper said. Deciding later that two
    // records were one person does not change what the paper said.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);

      await merge(client, absorbed, survivor, fx.staffId);

      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM consent_artifact WHERE data_principal_id = $1",
        [absorbed],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it("a withdrawal on the absorbed side never loses", async () => {
    // The person said stop for this purpose. That the other half of their
    // identity had never said it must not bring processing back.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);
      const purpose = fx.purposeIds[0];

      await setRecord(client, absorbed, purpose, { status: "withdrawn", withdrawnAt: "2022-01-01T00:00:00Z" });
      await setRecord(client, survivor, purpose, { status: "active" });

      await merge(client, absorbed, survivor, fx.staffId);

      expect((await statusOf(client, survivor, purpose))!.status).toBe("withdrawn");
      expect(await statusOf(client, absorbed, purpose)).toBeNull();
    });
  });

  it("a withdrawal on the survivor side never loses either", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);
      const purpose = fx.purposeIds[0];

      await setRecord(client, survivor, purpose, { status: "withdrawn", withdrawnAt: "2022-01-01T00:00:00Z" });
      await setRecord(client, absorbed, purpose, { status: "active", givenOn: "2023-05-05" });

      await merge(client, absorbed, survivor, fx.staffId);

      // Even though the absorbed side carries the later signature, a withdrawal
      // outranks it - the same direction commitDraft takes.
      expect((await statusOf(client, survivor, purpose))!.status).toBe("withdrawn");
    });
  });

  it("keeps the earliest withdrawal when both sides withdrew", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);
      const purpose = fx.purposeIds[0];

      await setRecord(client, absorbed, purpose, { status: "withdrawn", withdrawnAt: "2020-02-02T00:00:00Z" });
      await setRecord(client, survivor, purpose, { status: "withdrawn", withdrawnAt: "2023-03-03T00:00:00Z" });

      await merge(client, absorbed, survivor, fx.staffId);

      const { rows } = await client.query<{ withdrawn_at: Date }>(
        "SELECT withdrawn_at FROM consent_record WHERE data_principal_id = $1 AND purpose_id = $2",
        [survivor, purpose],
      );
      // Processing should have stopped at the first refusal, not the second.
      expect(rows[0].withdrawn_at.toISOString().slice(0, 4)).toBe("2020");
    });
  });

  it("lets the later signature win when neither side withdrew", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);
      const purpose = fx.purposeIds[0];

      await setRecord(client, absorbed, purpose, { status: "declined", givenOn: "2023-09-09" });
      await setRecord(client, survivor, purpose, { status: "active", givenOn: "2019-01-01" });

      const result = await merge(client, absorbed, survivor, fx.staffId);

      expect((await statusOf(client, survivor, purpose))!.status).toBe("declined");
      expect(result.decisions.find((d) => d.purposeId === purpose)?.winner).toBe("absorbed");
    });
  });

  it("never lets an undated record beat a dated one", async () => {
    // Same reasoning as commitDraft: an undated form cannot be shown to be
    // later than anything.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);
      const purpose = fx.purposeIds[0];

      await client.query(
        "UPDATE consent_record SET status='declined', consent_given_on=NULL WHERE data_principal_id=$1 AND purpose_id=$2",
        [absorbed, purpose],
      );
      await setRecord(client, survivor, purpose, { status: "active", givenOn: "2019-01-01" });

      await merge(client, absorbed, survivor, fx.staffId);

      expect((await statusOf(client, survivor, purpose))!.status).toBe("active");
    });
  });

  it("moves a purpose the survivor had no answer for", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);
      const purpose = fx.purposeIds[2];

      await client.query(
        "DELETE FROM consent_record WHERE data_principal_id = $1 AND purpose_id = $2",
        [survivor, purpose],
      );

      const result = await merge(client, absorbed, survivor, fx.staffId);

      expect(result.recordsMoved).toBe(1);
      expect(await statusOf(client, survivor, purpose)).not.toBeNull();
    });
  });

  it("records the merge from both sides of the chain", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);

      await merge(client, absorbed, survivor, fx.staffId);

      const { rows } = await client.query<{ data_principal_id: string }>(
        "SELECT data_principal_id FROM audit_log WHERE action = 'principals_merged'",
      );
      const ids = rows.map((r) => r.data_principal_id);
      expect(ids).toContain(survivor);
      expect(ids).toContain(absorbed);
    });
  });

  it("keeps the absorbed person's phone working at the portal", async () => {
    // The contact point lives on the absorbed row, and requestOtp used to filter
    // merged_into_id IS NULL - so merging a duplicate silently stopped that
    // person's own number from reaching anybody. s.6(4) failing for exactly the
    // people a merge is meant to help. The read follows the chain instead.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);

      await merge(client, absorbed, survivor, fx.staffId);

      const issued = await requestOtp("9876500101", null, client);
      if ("rateLimited" in issued) throw new Error("unexpectedly rate limited");
      const outcome = await verifyOtp(issued.challengeId, issued.devCode!, null, client);

      expect(outcome).toMatchObject({ ok: true });
      // It reaches the survivor, who holds their consent now - not the absorbed
      // identity, whose records have moved.
      expect((outcome as { principalIds: string[] }).principalIds).toEqual([survivor]);
    });
  });

  it("refuses a self-merge, a re-merge, and a cycle", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { absorbed, survivor } = await twoPeople(client, fx);

      await expect(merge(client, survivor, survivor, fx.staffId)).rejects.toBeInstanceOf(MergeError);

      await merge(client, absorbed, survivor, fx.staffId);
      await expect(merge(client, absorbed, survivor, fx.staffId)).rejects.toMatchObject({
        code: "already_merged",
      });
      // survivor -> absorbed would close the loop and leave resolvePrincipalId
      // with nowhere to terminate.
      await expect(merge(client, survivor, absorbed, fx.staffId)).rejects.toMatchObject({
        code: "would_cycle",
      });
    });
  });
});
