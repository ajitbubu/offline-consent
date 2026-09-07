import { describe, expect, it } from "vitest";
import { latestFiduciaryContact, loadNotices, loadPurposes } from "@/lib/catalogue";
import { seedFixture, withRollback } from "./helpers/db";

describe("loadPurposes", () => {
  it("returns active purposes in display order", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const purposes = await loadPurposes(client);
      const mine = purposes.filter((p) => fx.purposeIds.includes(p.id));
      expect(mine).toHaveLength(3);
      expect(mine.map((p) => p.display_order)).toEqual([...mine.map((p) => p.display_order)].sort());
    });
  });

  it("leaves out a retired purpose", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await client.query(`UPDATE purpose SET is_active = false WHERE id = $1`, [
        fx.purposeIds[0],
      ]);
      const ids = (await loadPurposes(client)).map((p) => p.id);
      expect(ids).not.toContain(fx.purposeIds[0]);
      expect(ids).toContain(fx.purposeIds[1]);
    });
  });
});

describe("loadNotices", () => {
  it("carries the verbatim printed label for each tick-box", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const notice = (await loadNotices(client)).find((n) => n.id === fx.noticeId);
      expect(notice).toBeDefined();
      // These labels are what get stored on the artifact, so the reviewer has to
      // be choosing between the actual words printed on the paper.
      expect(notice!.purposes.map((p) => p.printed_label)).toEqual(fx.labels);
    });
  });

  it("hides a notice that has not been published", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await client.query(`UPDATE consent_notice SET published_at = NULL WHERE id = $1`, [
        fx.noticeId,
      ]);
      expect((await loadNotices(client)).find((n) => n.id === fx.noticeId)).toBeUndefined();
    });
  });

  it("returns an empty purpose list rather than null for a notice with no tick-boxes", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO consent_notice
           (code, version, form_label, title, body, fiduciary_contact, published_at)
         VALUES ($1, 1, 'Bare', 'Notice', 'Body', 'dpo@example.org', now())
         RETURNING id`,
        [`bare-${Math.random().toString(36).slice(2, 10)}`],
      );
      const notice = (await loadNotices(client)).find((n) => n.id === rows[0].id);
      // The FILTER + COALESCE in the aggregate exists for exactly this row; a
      // null here would crash every caller that maps over purposes.
      expect(notice!.purposes).toEqual([]);
    });
  });
});

describe("latestFiduciaryContact", () => {
  it("comes from the most recently published notice, so the footer cannot drift", async () => {
    await withRollback(async (client) => {
      await seedFixture(client);
      await client.query(
        `INSERT INTO consent_notice
           (code, version, form_label, title, body, fiduciary_contact, published_at)
         VALUES ($1, 1, 'Newest', 'Notice', 'Body', 'newest@example.org', now() + interval '1 day')`,
        [`late-${Math.random().toString(36).slice(2, 10)}`],
      );
      expect(await latestFiduciaryContact(client)).toBe("newest@example.org");
    });
  });
});
