import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { commitDraft } from "@/lib/intake";
import { countNoticesOwed, loadNoticeQueue, recordNoticeDelivered } from "@/lib/notices";
import { insertDraft, seedFixture, withRollback, type Fixture } from "./helpers/db";

/** Commits a form recording the given notice state, and returns the person. */
async function personWithNotice(
  client: PoolClient,
  fx: Fixture,
  noticeAtCollection: "none" | "unknown" | "printed_on_form",
  phone = "9876500401",
  collectedOn = "2019-03-04",
) {
  const draftId = await insertDraft(client, fx, { phone, collectedOn });
  await client.query(
    `UPDATE intake_draft
        SET payload = jsonb_set(payload, '{noticeAtCollection}', to_jsonb($2::text))
      WHERE id = $1`,
    [draftId, noticeAtCollection],
  );
  const { dataPrincipalId } = await commitDraft({ draftId, staffId: fx.staffId }, client);
  return dataPrincipalId;
}

const owed = async (client: PoolClient, principalId: string) =>
  (await loadNoticeQueue(client)).some((r) => r.data_principal_id === principalId);

describe("the s.5(2) notice queue", () => {
  it("owes a notice for a form that carried none", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await personWithNotice(client, fx, "none");
      expect(await owed(client, id)).toBe(true);
    });
  });

  it("treats 'unknown' as owed, because not knowing is not evidence one was given", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await personWithNotice(client, fx, "unknown", "9876500402");
      expect(await owed(client, id)).toBe(true);
    });
  });

  it("owes nothing for a form that printed the notice on it", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await personWithNotice(client, fx, "printed_on_form", "9876500403");
      expect(await owed(client, id)).toBe(false);
    });
  });

  it("drops out of the queue once delivery is recorded", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await personWithNotice(client, fx, "none", "9876500404");
      expect(await owed(client, id)).toBe(true);

      await recordNoticeDelivered(
        {
          principalId: id,
          staffId: fx.staffId,
          channel: "post",
          note: "Posted to the address on the form",
        },
        client,
      );

      // Delivery lives in audit_log rather than a status column: the evidence
      // that a person got their notice is exactly what must be append-only.
      expect(await owed(client, id)).toBe(false);
    });
  });

  it("records the channel and the reason, since 'delivered' alone is not evidence", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await personWithNotice(client, fx, "none", "9876500405");
      await recordNoticeDelivered(
        { principalId: id, staffId: fx.staffId, channel: "email", note: "Sent to the address on file" },
        client,
      );

      const { rows } = await client.query<{
        new_state: { channel: string };
        reason: string;
        compliance_tags: string[];
      }>(
        `SELECT new_state, reason, compliance_tags FROM audit_log
          WHERE action = 'notice_delivered' AND data_principal_id = $1`,
        [id],
      );
      expect(rows[0].new_state.channel).toBe("email");
      expect(rows[0].reason).toBe("Sent to the address on file");
      expect(rows[0].compliance_tags).toContain("dpdp_s5_2");
    });
  });

  it("counts a person once however many forms of theirs owe a notice", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const before = await countNoticesOwed(client);
      const id = await personWithNotice(client, fx, "none", "9876500406");
      // A second, DIFFERENT form for the same person - same contact point and
      // name, different paper. An identical one is refused by payload_hash.
      await personWithNotice(client, fx, "none", "9876500406", "2021-07-19");
      const after = await countNoticesOwed(client);

      expect(await owed(client, id)).toBe(true);
      // The obligation is to the PERSON, not to each sheet of paper.
      expect(after).toBe(before + 1);
    });
  });

  it("leaves a merged identity out, so the queue is not worked twice", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await personWithNotice(client, fx, "none", "9876500407");
      expect(await owed(client, id)).toBe(true);

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO data_principal (full_name, phone_e164)
         VALUES ('Survivor Person', '+919876500408') RETURNING id`,
      );
      await client.query(`UPDATE data_principal SET merged_into_id = $2 WHERE id = $1`, [
        id,
        rows[0].id,
      ]);
      expect(await owed(client, id)).toBe(false);
    });
  });
});
