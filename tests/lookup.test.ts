import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { commitDraft } from "@/lib/intake";
import {
  countOpenLookupRequests,
  fileLookupRequest,
  loadLookupRequests,
  rejectLookupRequest,
  resolveLookupRequest,
} from "@/lib/lookup";
import { insertDraft, seedFixture, withRollback, type Fixture } from "./helpers/db";

const file = (
  client: PoolClient,
  overrides: Partial<{ claimedName: string; contactNote: string; formReference: string | null }> = {},
  ip: string | null = "203.0.113.7",
) =>
  fileLookupRequest(
    {
      claimedName: overrides.claimedName ?? "Ravi Chandran",
      contactNote:
        overrides.contactNote ??
        "I signed a form at the Anna Nagar branch in 2019. My number is 98765 00301.",
      formReference: overrides.formReference ?? null,
    },
    ip,
    "test-agent",
    client,
  );

const auditActions = async (client: PoolClient) => {
  const { rows } = await client.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE action LIKE 'lookup_request%' ORDER BY "timestamp"`,
  );
  return rows.map((r) => r.action);
};

describe("the lookup-request escape hatch", () => {
  it("files a request and makes it readable, which it never was before", async () => {
    await withRollback(async (client) => {
      const result = await file(client);
      expect("rateLimited" in result).toBe(false);

      // The whole defect: the row existed and no read path reached it.
      const open = await loadLookupRequests("open", client);
      const mine = open.find((r) => r.claimed_name === "Ravi Chandran");
      expect(mine).toBeDefined();
      expect(mine!.contact_note).toContain("Anna Nagar");
      expect(mine!.status).toBe("open");
    });
  });

  it("audits the filing, because it is a person unable to exercise s.6(4)", async () => {
    await withRollback(async (client) => {
      await file(client);
      expect(await auditActions(client)).toContain("lookup_request_filed");

      const { rows } = await client.query<{ compliance_tags: string[]; ip_address: string | null }>(
        `SELECT compliance_tags, ip_address::text FROM audit_log
          WHERE action = 'lookup_request_filed' ORDER BY "timestamp" DESC LIMIT 1`,
      );
      expect(rows[0].compliance_tags).toContain("dpdp_s6_4");
      // The column is a network type, so it comes back with its prefix length.
      expect(rows[0].ip_address).toMatch(/^203\.0\.113\.7(\/32)?$/);
    });
  });

  it("stores the address only as a hash, never the address itself", async () => {
    await withRollback(async (client) => {
      await file(client, {}, "203.0.113.9");
      const { rows } = await client.query<{ ip_hash: string | null }>(
        `SELECT ip_hash FROM principal_lookup_request ORDER BY created_at DESC LIMIT 1`,
      );
      expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].ip_hash).not.toContain("203.0.113.9");
    });
  });

  it("refuses a flood from one address, so the queue stays readable", async () => {
    await withRollback(async (client) => {
      const ip = "198.51.100.4";
      for (let i = 0; i < 5; i += 1) {
        expect("rateLimited" in (await file(client, {}, ip))).toBe(false);
      }
      // Flooding this table buries the genuine requests, and the people in it
      // have no other route back to their record.
      expect(await file(client, {}, ip)).toEqual({ rateLimited: true });
    });
  });

  it("counts a different address separately", async () => {
    await withRollback(async (client) => {
      for (let i = 0; i < 5; i += 1) await file(client, {}, "198.51.100.5");
      expect("rateLimited" in (await file(client, {}, "198.51.100.6"))).toBe(false);
    });
  });

  it("still accepts a request when the address is unknown", async () => {
    await withRollback(async (client) => {
      // clientIp returns null unless TRUST_PROXY says a proxy sets the header.
      // The limit has to fall open, not closed: refusing everyone behind an
      // unknown address would close the escape hatch entirely.
      for (let i = 0; i < 8; i += 1) {
        expect("rateLimited" in (await file(client, {}, null))).toBe(false);
      }
    });
  });
});

describe("working the queue", () => {
  const person = async (client: PoolClient, fx: Fixture) => {
    const { dataPrincipalId } = await commitDraft(
      { draftId: await insertDraft(client, fx, { phone: "9876500302" }), staffId: fx.staffId },
      client,
    );
    return dataPrincipalId;
  };

  it("resolves against the person it turned out to be, and says who did it", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const principalId = await person(client, fx);
      const filed = await file(client);
      const id = (filed as { id: string }).id;

      expect(
        await resolveLookupRequest(id, fx.staffId, principalId, "Form reference matched", client),
      ).toBe(true);

      const resolved = await loadLookupRequests("resolved", client);
      const mine = resolved.find((r) => r.id === id);
      expect(mine!.resolved_principal_id).toBe(principalId);
      expect(mine!.handled_by_name).toBe("Test Operator");
      expect(mine!.handled_at).not.toBeNull();
    });
  });

  it("ties the person to the request in the audit trail", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const principalId = await person(client, fx);
      const id = ((await file(client)) as { id: string }).id;
      await resolveLookupRequest(id, fx.staffId, principalId, "Matched on branch", client);

      // The resolving entry is the first thing that can carry a principal id -
      // before it, nobody knew who the requester was.
      const { rows } = await client.query<{ data_principal_id: string | null }>(
        `SELECT data_principal_id FROM audit_log
          WHERE action = 'lookup_request_resolved' ORDER BY "timestamp" DESC LIMIT 1`,
      );
      expect(rows[0].data_principal_id).toBe(principalId);
    });
  });

  it("keeps a rejection with its reason rather than deleting it", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = ((await file(client)) as { id: string }).id;

      expect(
        await rejectLookupRequest(id, fx.staffId, "Searched name and both numbers, nothing", client),
      ).toBe(true);

      const rejected = await loadLookupRequests("rejected", client);
      expect(rejected.find((r) => r.id === id)).toBeDefined();
      expect(await auditActions(client)).toContain("lookup_request_rejected");
    });
  });

  it("refuses to handle the same request twice", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const principalId = await person(client, fx);
      const id = ((await file(client)) as { id: string }).id;

      expect(await rejectLookupRequest(id, fx.staffId, "Nothing on file", client)).toBe(true);
      // Two DPOs working the queue at once must not both close it, and the
      // second must not overwrite the first one's finding.
      expect(
        await resolveLookupRequest(id, fx.staffId, principalId, "Found later", client),
      ).toBe(false);
    });
  });

  it("counts what is waiting, and how much of it has gone stale", async () => {
    await withRollback(async (client) => {
      const before = await countOpenLookupRequests(client);
      await file(client);
      const after = await countOpenLookupRequests(client);
      expect(after.open).toBe(before.open + 1);

      await client.query(
        `UPDATE principal_lookup_request SET created_at = now() - interval '9 days'
          WHERE status = 'open'`,
      );
      expect((await countOpenLookupRequests(client)).stale).toBeGreaterThan(0);
    });
  });
});
