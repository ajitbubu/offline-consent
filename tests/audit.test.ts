import { describe, expect, it } from "vitest";
import { clientIp, userAgent, writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { withRollback, seedFixture } from "./helpers/db";

const req = (headers: Record<string, string>) =>
  new Request("https://example.org/x", { headers });

describe("writeAudit", () => {
  it("stores the entry with its compliance tags", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await writeAudit(
        {
          action: "staff_login",
          actorType: "staff",
          actorId: fx.staffId,
          reason: "test",
          complianceTags: ["dpdp_s6_4"],
        },
        client,
      );

      const { rows } = await client.query<{
        action: string;
        compliance_tags: string[];
        previous_state: unknown;
        new_state: unknown;
      }>(
        `SELECT action, compliance_tags, previous_state, new_state FROM audit_log
          WHERE actor_id = $1 ORDER BY "timestamp" DESC LIMIT 1`,
        [fx.staffId],
      );
      expect(rows[0].action).toBe("staff_login");
      expect(rows[0].compliance_tags).toEqual(["dpdp_s6_4"]);
      // Absent states are stored as {} rather than null, so a reader never has
      // to distinguish "no previous state" from "column not written".
      expect(rows[0].previous_state).toEqual({});
      expect(rows[0].new_state).toEqual({});
    });
  });

  it("carries no foreign key to the person it describes", async () => {
    // Invariant 2: evidence has to outlive erasure of the identity it is about,
    // so audit_log must NOT be constrained to data_principal.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n
           FROM information_schema.table_constraints tc
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
          WHERE tc.table_name = 'audit_log'
            AND tc.constraint_type = 'FOREIGN KEY'
            AND ccu.table_name = 'data_principal'`,
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  it("refuses to be edited or deleted, by trigger rather than convention", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await writeAudit(
        { action: "staff_login", actorType: "staff", actorId: fx.staffId },
        client,
      );
      // Invariant 1. These must fail at the database, not in application code.
      await expect(
        client.query(`UPDATE audit_log SET reason = 'tampered' WHERE actor_id = $1`, [
          fx.staffId,
        ]),
      ).rejects.toThrow();
    });

    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      await writeAudit(
        { action: "staff_login", actorType: "staff", actorId: fx.staffId },
        client,
      );
      await expect(
        client.query(`DELETE FROM audit_log WHERE actor_id = $1`, [fx.staffId]),
      ).rejects.toThrow();
    });
  });
});

describe("clientIp", () => {
  it("ignores X-Forwarded-For unless a proxy is trusted to set it", () => {
    // Believing the header unconditionally would let one rotating header defeat
    // every per-IP limit in the app, and would write attacker-chosen addresses
    // into a compliance record.
    const ip = clientIp(req({ "x-forwarded-for": "203.0.113.1" }));
    expect(ip).toBe(env.TRUST_PROXY ? "203.0.113.1" : null);
  });

  it("returns null when there is no address to be had", () => {
    expect(clientIp(req({}))).toBeNull();
  });
});

describe("userAgent", () => {
  it("truncates rather than letting an unbounded header into the row", () => {
    expect(userAgent(req({ "user-agent": "x".repeat(900) }))!.length).toBe(500);
  });

  it("is null when absent", () => {
    expect(userAgent(req({}))).toBeNull();
  });
});
