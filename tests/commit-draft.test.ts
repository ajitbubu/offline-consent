import { describe, expect, it } from "vitest";
import { commitDraft } from "@/lib/intake";
import { withdrawPurposes } from "@/lib/withdrawal";
import { insertDraft, seedFixture, withRollback } from "./helpers/db";

describe("commitDraft", () => {
  it("turns a draft into an artifact, its items and one record per purpose", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);
      const draftId = await insertDraft(client, fixture, { granted: [true, true, false] });

      const result = await commitDraft({ draftId, staffId: fixture.staffId }, client);

      expect(result.recordsWritten).toBe(3);

      const items = await client.query(
        "SELECT granted FROM consent_artifact_item WHERE artifact_id = $1 ORDER BY granted",
        [result.artifactId],
      );
      expect(items.rows.map((r) => r.granted)).toEqual([false, true, true]);

      // A refusal is recorded, not omitted: the portal must be able to show the
      // person every purpose they were asked about, including the ones they
      // declined, or they cannot check the refusal was captured.
      const records = await client.query(
        "SELECT status FROM consent_record WHERE data_principal_id = $1 ORDER BY status",
        [result.dataPrincipalId],
      );
      expect(records.rows.map((r) => r.status)).toEqual(["active", "active", "declined"]);
    });
  });

  it("normalises the phone number written on the form", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);
      const draftId = await insertDraft(client, fixture, { phone: "098765 00123" });

      const result = await commitDraft({ draftId, staffId: fixture.staffId }, client);

      const { rows } = await client.query(
        "SELECT phone_e164 FROM data_principal WHERE id = $1",
        [result.dataPrincipalId],
      );
      expect(rows[0].phone_e164).toBe("+919876500123");
    });
  });

  it("refuses a form whose phone number cannot be dialled", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);
      const draftId = await insertDraft(client, fixture, { phone: "9876 54", email: null });

      await expect(
        commitDraft({ draftId, staffId: fixture.staffId }, client),
      ).rejects.toMatchObject({ code: "validation_failed" });

      const { rows } = await client.query(
        "SELECT count(*)::int AS n FROM consent_artifact WHERE transcribed_by = $1",
        [fixture.staffId],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  it("cannot commit the same draft twice", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);
      const draftId = await insertDraft(client, fixture);

      await commitDraft({ draftId, staffId: fixture.staffId }, client);

      await expect(
        commitDraft({ draftId, staffId: fixture.staffId }, client),
      ).rejects.toMatchObject({ code: "draft_not_reviewable" });

      const { rows } = await client.query(
        "SELECT count(*)::int AS n FROM consent_artifact WHERE transcribed_by = $1",
        [fixture.staffId],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  it("does not resurrect a consent withdrawn after the form was signed", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);

      const first = await commitDraft(
        { draftId: await insertDraft(client, fixture), staffId: fixture.staffId },
        client,
      );

      await withdrawPurposes(
        {
          principalId: first.dataPrincipalId,
          purposeIds: [fixture.purposeIds[0]],
          channel: "portal",
          actorType: "data_principal",
          actorId: first.dataPrincipalId,
        },
        client,
      );

      // A second, still older, paper form with every box ticked.
      const second = await commitDraft(
        {
          draftId: await insertDraft(client, fixture, { collectedOn: "2019-06-15" }),
          staffId: fixture.staffId,
        },
        client,
      );

      expect(second.withheldPurposeIds).toEqual([fixture.purposeIds[0]]);

      const { rows } = await client.query(
        "SELECT status FROM consent_record WHERE data_principal_id = $1 AND purpose_id = $2",
        [first.dataPrincipalId, fixture.purposeIds[0]],
      );
      expect(rows[0].status).toBe("withdrawn");
    });
  });

  it("withholds against an undated form, which cannot be shown to predate a withdrawal", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);
      const first = await commitDraft(
        { draftId: await insertDraft(client, fixture), staffId: fixture.staffId },
        client,
      );
      await withdrawPurposes(
        {
          principalId: first.dataPrincipalId,
          purposeIds: [fixture.purposeIds[1]],
          channel: "portal",
          actorType: "data_principal",
          actorId: first.dataPrincipalId,
        },
        client,
      );

      const second = await commitDraft(
        {
          draftId: await insertDraft(client, fixture, { collectedOn: null }),
          staffId: fixture.staffId,
        },
        client,
      );

      expect(second.withheldPurposeIds).toContain(fixture.purposeIds[1]);
    });
  });

  it("lets a later form supersede an earlier one, but not the other way round", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);

      // Newest form first, so the second commit is the OLDER piece of paper.
      const newer = await commitDraft(
        {
          draftId: await insertDraft(client, fixture, {
            collectedOn: "2022-01-01",
            granted: [true, true, true],
          }),
          staffId: fixture.staffId,
        },
        client,
      );

      await commitDraft(
        {
          draftId: await insertDraft(client, fixture, {
            collectedOn: "2019-03-04",
            granted: [false, false, false],
          }),
          staffId: fixture.staffId,
        },
        client,
      );

      // The 2022 form still governs: an older form found later does not undo it.
      const { rows } = await client.query(
        `SELECT status, consent_given_on FROM consent_record
          WHERE data_principal_id = $1 AND purpose_id = $2`,
        [newer.dataPrincipalId, fixture.purposeIds[0]],
      );
      expect(rows[0].status).toBe("active");
      expect(rows[0].consent_given_on).toBe("2022-01-01");
    });
  });

  it("stops before creating a second record for a near-identical name", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);
      await commitDraft(
        {
          draftId: await insertDraft(client, fixture, { fullName: "Ravi Shankar Menon" }),
          staffId: fixture.staffId,
        },
        client,
      );

      const draftId = await insertDraft(client, fixture, { fullName: "Ravi Shanker Menon" });
      await expect(
        commitDraft({ draftId, staffId: fixture.staffId }, client),
      ).rejects.toMatchObject({ code: "possible_duplicate" });

      // ...but a human may overrule it.
      const forced = await commitDraft(
        { draftId, staffId: fixture.staffId, forceNew: true },
        client,
      );
      expect(forced.artifactId).toBeTruthy();
    });
  });

  it("writes the s.5(2) tag only when no notice was given at collection", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);
      const result = await commitDraft(
        { draftId: await insertDraft(client, fixture), staffId: fixture.staffId },
        client,
      );
      const { rows } = await client.query(
        "SELECT compliance_tags FROM audit_log WHERE artifact_id = $1",
        [result.artifactId],
      );
      expect(rows[0].compliance_tags).toEqual(["dpdp_s6_1"]);
      expect(result.noticeOwed).toBe(false);
    });
  });
});

describe("the artifact is immutable", () => {
  it("refuses UPDATE and DELETE at the database level", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client);
      const result = await commitDraft(
        { draftId: await insertDraft(client, fixture), staffId: fixture.staffId },
        client,
      );

      // Each attempt aborts the transaction, so it runs inside a savepoint.
      for (const sql of [
        `UPDATE consent_artifact SET collection_location = 'x' WHERE id = '${result.artifactId}'`,
        `DELETE FROM consent_artifact WHERE id = '${result.artifactId}'`,
        `UPDATE consent_artifact_item SET granted = false WHERE artifact_id = '${result.artifactId}'`,
        `DELETE FROM audit_log WHERE artifact_id = '${result.artifactId}'`,
      ]) {
        await client.query("SAVEPOINT attempt");
        await expect(client.query(sql)).rejects.toThrow(/append-only/);
        await client.query("ROLLBACK TO SAVEPOINT attempt");
      }
    });
  });
});
