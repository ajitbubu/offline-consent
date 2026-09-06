import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { buildDrafts, commitBatch, parseCsv } from "@/lib/bulk";
import { commitDraft } from "@/lib/intake";
import { pool } from "@/lib/db";
import { seedFixture, withRollback, type Fixture } from "./helpers/db";

async function batch(client: PoolClient, fx: Fixture) {
  const { rows: ev } = await client.query<{ id: string }>(
    `INSERT INTO evidence_object (storage_key, kind, content_type, original_filename, byte_size, sha256, retention_until, uploaded_by)
     VALUES ($1,'csv_source','text/csv','members.csv',10,$2, now() + interval '8 years', $3) RETURNING id`,
    [`test/${Math.random().toString(36).slice(2)}`, "a".repeat(64), fx.staffId],
  );
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO intake_batch (source_evidence_id, filename, created_by)
     VALUES ($1, 'members.csv', $2) RETURNING id`,
    [ev[0].id, fx.staffId],
  );
  return rows[0].id;
}

const purposesOf = (fx: Fixture) =>
  fx.purposeIds.map((id, i) => ({ id, code: `p${i}`, label: fx.labels[i] }));

const MAPPING = {
  full_name: "Name",
  phone: "Mobile",
  collected_on: "Signed",
  "purpose:p0": "Newsletter",
};

describe("parseCsv", () => {
  it("reads headers and drops blank lines", () => {
    const preview = parseCsv("Name,Mobile\nAsha,9876500001\n\n,\nRavi,9876500002\n");
    expect(preview.headers).toEqual(["Name", "Mobile"]);
    expect(preview.rowCount).toBe(2);
  });
});

describe("buildDrafts", () => {
  it("gives every row a draft, including the broken ones", async () => {
    // A row that vanishes between the spreadsheet and the review queue is worse
    // than one that arrives with an error on it: the operator has to be able to
    // account for all of them.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await batch(client, fx);
      const csv = [
        "Name,Mobile,Signed,Newsletter",
        "Asha Rao,9876500001,2019-03-04,yes",
        ",,,yes", // no name, no contact point
        "Ravi Menon,notaphone,2019-03-04,no",
      ].join("\n");

      const outcomes = await buildDrafts(
        { batchId: id, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId: fx.staffId, purposes: purposesOf(fx) },
        client,
      );

      expect(outcomes).toHaveLength(3);
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM intake_draft WHERE batch_id = $1",
        [id],
      );
      expect(Number(rows[0].n)).toBe(3);
      expect(outcomes[0].issues.filter((i) => i.severity === "error")).toHaveLength(0);
      expect(outcomes[1].issues.some((i) => i.severity === "error")).toBe(true);
      expect(outcomes[2].issues.some((i) => i.message.includes("dial"))).toBe(true);
    });
  });

  it("refuses an ambiguous date instead of picking a country", async () => {
    // 03/04/2019 is 3 April in one place and 4 March in another, and this
    // register exists to record which.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await batch(client, fx);
      const csv = "Name,Mobile,Signed,Newsletter\nAsha Rao,9876500001,03/04/2019,yes";

      const [row] = await buildDrafts(
        { batchId: id, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId: fx.staffId, purposes: purposesOf(fx) },
        client,
      );

      expect(row.issues.some((i) => i.severity === "error" && i.message.includes("ambiguous"))).toBe(true);
    });
  });

  it("refuses a tick-box value it does not recognise rather than reading it as no", async () => {
    // Silently treating an unreadable cell as "not agreed" would record a
    // refusal the paper never made.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await batch(client, fx);
      const csv = "Name,Mobile,Signed,Newsletter\nAsha Rao,9876500001,2019-03-04,maybe";

      const [row] = await buildDrafts(
        { batchId: id, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId: fx.staffId, purposes: purposesOf(fx) },
        client,
      );

      const err = row.issues.find((i) => i.severity === "error" && i.message.includes("not a yes"));
      expect(err).toBeDefined();
    });
  });

  it("accepts the spellings a real spreadsheet uses", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await batch(client, fx);
      const csv = [
        "Name,Mobile,Signed,Newsletter",
        "A One,9876500011,2019-03-04,Y",
        "B Two,9876500012,2019-03-04,TRUE",
        "C Three,9876500013,2019-03-04,x",
        "D Four,9876500014,2019-03-04,No",
      ].join("\n");

      const outcomes = await buildDrafts(
        { batchId: id, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId: fx.staffId, purposes: purposesOf(fx) },
        client,
      );
      expect(outcomes.every((o) => !o.issues.some((i) => i.message.includes("not a yes")))).toBe(true);
    });
  });

  it("keeps the raw row so the spreadsheet can be checked against the record", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await batch(client, fx);
      const csv = "Name,Mobile,Signed,Newsletter\nAsha Rao,9876500001,2019-03-04,yes";

      await buildDrafts(
        { batchId: id, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId: fx.staffId, purposes: purposesOf(fx) },
        client,
      );

      const { rows } = await client.query<{ source_row: Record<string, string> }>(
        "SELECT source_row FROM intake_draft WHERE batch_id = $1",
        [id],
      );
      expect(rows[0].source_row.Name).toBe("Asha Rao");
      expect(rows[0].source_row.Newsletter).toBe("yes");
    });
  });

  it("marks the batch validated with its row count", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await batch(client, fx);
      const csv = "Name,Mobile,Signed,Newsletter\nA One,9876500011,2019-03-04,yes\nB Two,9876500012,2019-03-04,no";

      await buildDrafts(
        { batchId: id, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId: fx.staffId, purposes: purposesOf(fx) },
        client,
      );

      const { rows } = await client.query<{ status: string; row_count: number }>(
        "SELECT status, row_count FROM intake_batch WHERE id = $1",
        [id],
      );
      expect(rows[0]).toMatchObject({ status: "validated", row_count: 2 });
    });
  });
});

describe("commitBatch", () => {
  it("does not commit a row the report marked as needing a person", async () => {
    // REGRESSION. commitDraft recomputes validation from the payload and knows
    // nothing about the CSV it came from, so an ambiguous date became a valid
    // UNDATED artifact and an unreadable tick-box became a purpose silently
    // missing from the evidence. Both committed cleanly and both recorded
    // something the spreadsheet did not say.
    const client = await pool.connect();
    let batchId: string, staffId: string;
    try {
      await client.query("BEGIN");
      const fx = await seedFixture(client);
      staffId = fx.staffId;
      batchId = await batch(client, fx);
      const csv = [
        "Name,Mobile,Signed,Newsletter",
        `Ambiguous Date,9876522221,03/04/2019,yes`,
        `Unreadable Box,9876522222,2019-03-04,maybe`,
      ].join("\n");
      await buildDrafts(
        { batchId, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId, purposes: purposesOf(fx) },
        client,
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    try {
      const result = await commitBatch(batchId!, staffId!);
      expect(result.committed).toBe(0);

      const { rows } = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM intake_draft WHERE batch_id = $1 AND status = 'needs_review'",
        [batchId!],
      );
      expect(Number(rows[0].n)).toBe(2);
    } finally {
      await pool.query("DELETE FROM intake_draft WHERE batch_id = $1", [batchId!]);
    }
  });

  it("commits the good rows and leaves the bad ones, each in its own transaction", async () => {
    // FR-15. A ten-thousand-row import that fails atomically on row 9,999 is
    // worthless. This runs on the pool rather than withRollback because that is
    // the property under test: separate transactions.
    const suffix = Math.random().toString(36).slice(2, 8);
    let batchId: string | undefined;
    const client = await pool.connect();
    let fx: Fixture;
    try {
      await client.query("BEGIN");
      fx = await seedFixture(client);
      batchId = await batch(client, fx);
      const csv = [
        "Name,Mobile,Signed,Newsletter",
        `Anaya Bhatt ${suffix},9876511111,2019-03-04,yes`,
        `,,,yes`,
        `Farhan Qureshi ${suffix},9876511112,2019-03-04,no`,
      ].join("\n");
      await buildDrafts(
        { batchId, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId: fx.staffId, purposes: purposesOf(fx) },
        client,
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    try {
      const result = await commitBatch(batchId!, fx!.staffId);

      expect(result.committed).toBe(2);
      // The broken row is HELD, not skipped: it was never attempted, because the
      // report already told the operator it needs a person.
      expect(result.skipped).toHaveLength(0);
      expect(result.held).toBe(1);

      const { rows } = await pool.query<{ status: string }>(
        "SELECT status FROM intake_batch WHERE id = $1",
        [batchId],
      );
      expect(rows[0].status).toBe("partially_committed");
    } finally {
      // consent_artifact is append-only and consent_record references the people
      // with ON DELETE RESTRICT, so the artifacts and principals this creates
      // stay behind. CI gets a fresh database; a developer's does not, which is
      // why the two names are deliberately dissimilar - an earlier pair called
      // "Good One" and "Good Two" scored 0.6 on the duplicate detector and
      // manufactured a false candidate on every run.
      await pool.query("DELETE FROM intake_draft WHERE batch_id = $1", [batchId]);
    }
  });
});

describe("re-importing the same CSV", () => {
  it("does not give one person two identical artifacts", async () => {
    // The gap that shipped with Phase 5: nothing read payload_hash, so running
    // the same import twice quietly doubled the evidence.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const csv = "Name,Mobile,Signed,Newsletter\nRepeat Person,9876577001,2019-03-04,yes";

      const first = await batch(client, fx);
      await buildDrafts(
        { batchId: first, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId: fx.staffId, purposes: purposesOf(fx) },
        client,
      );
      const { rows: d1 } = await client.query<{ id: string }>(
        "SELECT id FROM intake_draft WHERE batch_id = $1",
        [first],
      );
      const committed = await commitDraft({ draftId: d1[0].id, staffId: fx.staffId }, client);

      const second = await batch(client, fx);
      await buildDrafts(
        { batchId: second, text: csv, mapping: MAPPING, noticeId: fx.noticeId, staffId: fx.staffId, purposes: purposesOf(fx) },
        client,
      );
      const { rows: d2 } = await client.query<{ id: string }>(
        "SELECT id FROM intake_draft WHERE batch_id = $1",
        [second],
      );

      await expect(
        commitDraft({ draftId: d2[0].id, staffId: fx.staffId }, client),
      ).rejects.toMatchObject({ code: "already_recorded" });

      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM consent_artifact WHERE data_principal_id = $1",
        [committed.dataPrincipalId],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });
});
