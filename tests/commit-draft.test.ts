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

  it("refuses a form that answers the same purpose twice", async () => {
    // REGRESSION (R3). consent_artifact_item is written with ON CONFLICT DO
    // NOTHING (first wins) and the projection loop overwrites (last wins), so a
    // duplicated purpose left the immutable evidence saying "declined" and the
    // record enforcement reads saying "active" - about the same tick-box.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const purpose = fx.purposeIds[0];
      const payload = {
        principal: { fullName: "Dup Person", phone: "9876500042", phoneE164: null, email: null },
        noticeId: fx.noticeId,
        noticeAtCollection: "printed_on_form",
        collectedOn: "2019-03-04",
        collectedOnPrecision: "day",
        collectionLocation: null,
        subjectDeclaration: null,
        items: [
          { purposeId: purpose, granted: false, verbatimLabel: fx.labels[0] },
          { purposeId: purpose, granted: true, verbatimLabel: fx.labels[0] },
        ],
      };
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO intake_draft (source, payload, created_by) VALUES ('manual', $1, $2) RETURNING id",
        [JSON.stringify(payload), fx.staffId],
      );

      await expect(
        commitDraft({ draftId: rows[0].id, staffId: fx.staffId }, client),
      ).rejects.toMatchObject({ code: "validation_failed" });

      const artifacts = await client.query("SELECT 1 FROM consent_artifact WHERE intake_draft_id = $1", [rows[0].id]);
      expect(artifacts.rowCount).toBe(0);
    });
  });

  it("does not let a form dated 4 March override a withdrawal made on 5 March IST", async () => {
    // REGRESSION (R4). withdrawn_at is a TIMESTAMPTZ and was rendered with
    // .toISOString(), i.e. in UTC. 01:00 on 5 March in Asia/Kolkata is 19:30 on
    // 4 March in UTC, so the withdrawal compared as same-day against a form
    // dated 4 March, lost the strict `>`, and the consent came back on.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const first = await commitDraft(
        { draftId: await insertDraft(client, fx, { collectedOn: "2024-03-04" }), staffId: fx.staffId },
        client,
      );
      await withdrawPurposes(
        {
          principalId: first.dataPrincipalId,
          purposeIds: [fx.purposeIds[0]],
          channel: "portal",
          actorType: "data_principal",
          actorId: first.dataPrincipalId,
        },
        client,
      );
      await client.query(
        `UPDATE consent_record SET withdrawn_at = '2024-03-05 01:00:00+05:30'
          WHERE data_principal_id = $1 AND purpose_id = $2`,
        [first.dataPrincipalId, fx.purposeIds[0]],
      );

      const second = await commitDraft(
        { draftId: await insertDraft(client, fx, { collectedOn: "2024-03-04" }), staffId: fx.staffId },
        client,
      );

      expect(second.withheldPurposeIds).toContain(fx.purposeIds[0]);
      const { rows } = await client.query<{ status: string }>(
        "SELECT status FROM consent_record WHERE data_principal_id = $1 AND purpose_id = $2",
        [first.dataPrincipalId, fx.purposeIds[0]],
      );
      expect(rows[0].status).toBe("withdrawn");
    });
  });

  it("withholds when the form and the withdrawal fall on the same day", async () => {
    // A tie cannot be ordered from day-precision data, so it resolves toward
    // the withdrawal - the same direction auth.ts:revokedBy takes.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const first = await commitDraft(
        { draftId: await insertDraft(client, fx, { collectedOn: "2024-03-04" }), staffId: fx.staffId },
        client,
      );
      await withdrawPurposes(
        {
          principalId: first.dataPrincipalId,
          purposeIds: [fx.purposeIds[0]],
          channel: "portal",
          actorType: "data_principal",
          actorId: first.dataPrincipalId,
        },
        client,
      );
      await client.query(
        `UPDATE consent_record SET withdrawn_at = '2024-03-04 14:00:00+05:30'
          WHERE data_principal_id = $1 AND purpose_id = $2`,
        [first.dataPrincipalId, fx.purposeIds[0]],
      );

      const second = await commitDraft(
        { draftId: await insertDraft(client, fx, { collectedOn: "2024-03-04" }), staffId: fx.staffId },
        client,
      );
      expect(second.withheldPurposeIds).toContain(fx.purposeIds[0]);
    });
  });

  it("does not let an undated form overwrite a dated record", async () => {
    // REGRESSION (R6). The supersession guard required BOTH dates to be
    // non-null before it would skip, so an undated form fell straight through
    // to the UPDATE and replaced a dated consent - nulling consent_given_on on
    // the way. An undated form cannot be shown to be later than anything.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const first = await commitDraft(
        { draftId: await insertDraft(client, fx, { collectedOn: "2023-01-01" }), staffId: fx.staffId },
        client,
      );

      const second = await commitDraft(
        {
          draftId: await insertDraft(client, fx, { collectedOn: null, granted: [false, false, false] }),
          staffId: fx.staffId,
        },
        client,
      );
      expect(second.recordsWritten).toBe(0);

      const { rows } = await client.query<{ status: string; consent_given_on: string | null }>(
        "SELECT status, consent_given_on FROM consent_record WHERE data_principal_id = $1 AND purpose_id = $2",
        [first.dataPrincipalId, fx.purposeIds[0]],
      );
      expect(rows[0].status).toBe("active");
      expect(rows[0].consent_given_on).toBe("2023-01-01");
    });
  });

  it("learns a contact point a later form supplies", async () => {
    // matchPrincipal resolves on phone OR email, so this person was found by
    // their phone number and the email on the second form used to be dropped.
    // A contact point we were given and did not store is a withdrawal route
    // that person will never have.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const first = await commitDraft(
        { draftId: await insertDraft(client, fx, { phone: "9876500001", email: null }), staffId: fx.staffId },
        client,
      );

      const second = await commitDraft(
        {
          draftId: await insertDraft(client, fx, {
            phone: "9876500001",
            email: "person@example.org",
            collectedOn: "2020-05-05",
          }),
          staffId: fx.staffId,
        },
        client,
      );
      expect(second.dataPrincipalId).toBe(first.dataPrincipalId);

      const { rows } = await client.query<{ phone_e164: string; email: string | null }>(
        "SELECT phone_e164, email FROM data_principal WHERE id = $1",
        [first.dataPrincipalId],
      );
      expect(rows[0].phone_e164).toBe("+919876500001");
      expect(rows[0].email).toBe("person@example.org");

      const { rows: audit } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE data_principal_id = $1 AND new_state->>'change' = 'contact_point_learned'`,
        [first.dataPrincipalId],
      );
      expect(Number(audit[0].n)).toBe(1);
    });
  });

  it("covers the printed wording in the payload hash", async () => {
    // The verbatim label is what the person actually ticked - the most legally
    // significant field on the artifact - and it was outside the integrity
    // hash, so two artifacts recording different printed wording hashed the same.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);

      const draft = async (label: string) => {
        const payload = {
          principal: { fullName: "Hash Person", phone: "9876500077", phoneE164: null, email: null },
          noticeId: fx.noticeId,
          noticeAtCollection: "printed_on_form",
          collectedOn: "2019-03-04",
          collectedOnPrecision: "day",
          collectionLocation: null,
          subjectDeclaration: null,
          items: [{ purposeId: fx.purposeIds[0], granted: true, verbatimLabel: label }],
        };
        const { rows } = await client.query<{ id: string }>(
          "INSERT INTO intake_draft (source, payload, created_by) VALUES ('manual', $1, $2) RETURNING id",
          [JSON.stringify(payload), fx.staffId],
        );
        return rows[0].id;
      };

      const a = await commitDraft({ draftId: await draft("I agree to marketing"), staffId: fx.staffId }, client);
      const b = await commitDraft({ draftId: await draft("I agree to everything"), staffId: fx.staffId }, client);

      const { rows } = await client.query<{ payload_hash: string }>(
        "SELECT payload_hash FROM consent_artifact WHERE id = ANY($1::uuid[])",
        [[a.artifactId, b.artifactId]],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].payload_hash).not.toBe(rows[1].payload_hash);
    });
  });

  it("attaches a form to the survivor when the chosen person has been merged", async () => {
    // The confirmPrincipalId path checked only that the row existed, so an
    // artifact could be attached to an absorbed identity - which the portal
    // resolves past, making those consents unwithdrawable.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const first = await commitDraft(
        { draftId: await insertDraft(client, fx, { phone: "9876500011" }), staffId: fx.staffId },
        client,
      );
      const { rows: survivor } = await client.query<{ id: string }>(
        "INSERT INTO data_principal (full_name, phone_e164) VALUES ($1, $2) RETURNING id",
        ["Survivor Person", "+919876500012"],
      );
      await client.query("UPDATE data_principal SET merged_into_id = $2 WHERE id = $1", [
        first.dataPrincipalId,
        survivor[0].id,
      ]);

      const second = await commitDraft(
        {
          draftId: await insertDraft(client, fx, { phone: "9876500011", collectedOn: "2021-06-06" }),
          staffId: fx.staffId,
          confirmPrincipalId: first.dataPrincipalId,
        },
        client,
      );

      expect(second.dataPrincipalId).toBe(survivor[0].id);
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM consent_record WHERE data_principal_id = $1",
        [survivor[0].id],
      );
      expect(Number(rows[0].n)).toBeGreaterThan(0);
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
