/**
 * Transaction-rollback isolation.
 *
 * Every test runs inside a transaction that is rolled back afterwards, so specs
 * cannot see each other's rows and the database is left as it was found.
 *
 * Rollback rather than TRUNCATE: consent_artifact, consent_artifact_item and
 * audit_log all reject TRUNCATE by trigger, by design, so a truncate-based
 * cleanup could not work here even if it were wanted.
 */
import type { PoolClient } from "pg";
import { pool } from "@/lib/db";

export async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

export interface Fixture {
  staffId: string;
  noticeId: string;
  purposeIds: string[];
  labels: string[];
}

/** Minimal catalogue and a staff user, created inside the caller's transaction. */
export async function seedFixture(client: PoolClient): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);

  const staff = await client.query<{ id: string }>(
    `INSERT INTO staff_user (email, password_hash, full_name, role)
     VALUES ($1, 'x', 'Test Operator', 'dpo') RETURNING id`,
    [`t-${suffix}@example.org`],
  );

  const purposeIds: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const p = await client.query<{ id: string }>(
      `INSERT INTO purpose (code, name, description, display_order)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`p-${suffix}-${i}`, `Purpose ${i}`, `Description ${i}`, i],
    );
    purposeIds.push(p.rows[0].id);
    labels.push(`I agree to purpose ${i}`);
  }

  const notice = await client.query<{ id: string }>(
    `INSERT INTO consent_notice
       (code, version, form_label, title, body, fiduciary_contact, published_at)
     VALUES ($1, 1, 'Test Form', 'Notice', 'Body', 'dpo@example.org', now())
     RETURNING id`,
    [`n-${suffix}`],
  );

  for (let i = 0; i < purposeIds.length; i += 1) {
    await client.query(
      `INSERT INTO consent_notice_purpose (notice_id, purpose_id, printed_label, display_order)
       VALUES ($1, $2, $3, $4)`,
      [notice.rows[0].id, purposeIds[i], labels[i], i],
    );
  }

  return {
    staffId: staff.rows[0].id,
    noticeId: notice.rows[0].id,
    purposeIds,
    labels,
  };
}

/** Inserts a draft ready for commit. */
export async function insertDraft(
  client: PoolClient,
  fixture: Fixture,
  overrides: {
    fullName?: string;
    phone?: string | null;
    email?: string | null;
    collectedOn?: string | null;
    granted?: boolean[];
  } = {},
): Promise<string> {
  const payload = {
    principal: {
      fullName: overrides.fullName ?? "Test Person",
      phone: overrides.phone === undefined ? "9876500001" : overrides.phone,
      phoneE164: null,
      email: overrides.email ?? null,
    },
    noticeId: fixture.noticeId,
    noticeAtCollection: "printed_on_form",
    collectedOn: overrides.collectedOn === undefined ? "2019-03-04" : overrides.collectedOn,
    collectedOnPrecision: overrides.collectedOn === null ? "unknown" : "day",
    collectionLocation: null,
    subjectDeclaration: null,
    items: fixture.purposeIds.map((purposeId, i) => ({
      purposeId,
      granted: overrides.granted?.[i] ?? true,
      verbatimLabel: fixture.labels[i],
    })),
  };

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO intake_draft (source, payload, created_by) VALUES ('manual', $1, $2) RETURNING id`,
    [JSON.stringify(payload), fixture.staffId],
  );
  return rows[0].id;
}
