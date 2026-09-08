import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { commitDraft } from "@/lib/intake";
import { withdrawPurposes } from "@/lib/withdrawal";
import {
  loadArtifacts,
  loadAuditTrail,
  loadConsents,
  loadPrincipal,
  recordPrincipalView,
  searchPrincipals,
} from "@/lib/register";
import { insertDraft, seedFixture, withRollback, type Fixture } from "./helpers/db";

async function person(
  client: PoolClient,
  fx: Fixture,
  overrides: { fullName?: string; phone?: string | null; email?: string | null } = {},
) {
  const draftId = await insertDraft(client, fx, {
    fullName: overrides.fullName ?? "Ravi Shankar Menon",
    phone: overrides.phone === undefined ? "9876500501" : overrides.phone,
    email: overrides.email ?? null,
  });
  const { dataPrincipalId } = await commitDraft({ draftId, staffId: fx.staffId }, client);
  return dataPrincipalId;
}

describe("searchPrincipals", () => {
  it("refuses a term too short to be a search", async () => {
    await withRollback(async (client) => {
      // Otherwise a single character trigram-matches most of the register, which
      // is browsing it rather than searching it.
      expect(await searchPrincipals("a", client)).toEqual([]);
      expect(await searchPrincipals(" ", client)).toEqual([]);
    });
  });

  it("finds a person by name", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await person(client, fx);
      const found = await searchPrincipals("Ravi Shankar", client);
      expect(found.map((r) => r.id)).toContain(id);
    });
  });

  it("finds a number typed the way it appears on paper", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await person(client, fx, { phone: "9876500502" });
      // Stored as +919876500502. Search and storage must not disagree about
      // what a number is, so the same normaliser runs on both sides.
      const found = await searchPrincipals("98765 00502", client);
      expect(found.map((r) => r.id)).toContain(id);
    });
  });

  it("counts artifacts and consent state per row", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await person(client, fx, { phone: "9876500503" });
      await withdrawPurposes(
        {
          principalId: id,
          purposeIds: [fx.purposeIds[0]],
          channel: "portal",
          actorType: "data_principal",
          actorId: id,
        },
        client,
      );

      const row = (await searchPrincipals("Ravi Shankar", client)).find((r) => r.id === id)!;
      expect(row.artifacts).toBe(1);
      expect(row.withdrawn_consents).toBe(1);
      expect(row.active_consents).toBe(fx.purposeIds.length - 1);
    });
  });

  it("still finds an absorbed identity, unlike the portal", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await person(client, fx, { phone: "9876500504" });
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO data_principal (full_name, phone_e164)
         VALUES ('Ravi Shankar Menon', '+919876500505') RETURNING id`,
      );
      await client.query(`UPDATE data_principal SET merged_into_id = $2 WHERE id = $1`, [
        id,
        rows[0].id,
      ]);

      // A DPO needs to find where an absorbed record went. That is the opposite
      // of what the portal needs, which is why the filter lives in the caller.
      const found = await searchPrincipals("Ravi Shankar", client);
      const absorbed = found.find((r) => r.id === id);
      expect(absorbed).toBeDefined();
      expect(absorbed!.merged_into_id).toBe(rows[0].id);
    });
  });
});

describe("one person's whole record", () => {
  it("returns the artifact, the consents and the trail", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await person(client, fx, { phone: "9876500506" });

      expect((await loadPrincipal(id, client))!.full_name).toBe("Ravi Shankar Menon");
      expect(await loadArtifacts(id, client)).toHaveLength(1);
      expect(await loadConsents(id, client)).toHaveLength(fx.purposeIds.length);
      expect((await loadAuditTrail(id, 200, client)).map((a) => a.action)).toContain(
        "consent_digitised",
      );
    });
  });

  it("is null for an id that is not in the register", async () => {
    await withRollback(async (client) => {
      expect(
        await loadPrincipal("00000000-0000-0000-0000-000000000000", client),
      ).toBeNull();
    });
  });
});

describe("recordPrincipalView", () => {
  it("writes an entry, because nobody browses this anonymously", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await person(client, fx, { phone: "9876500507" });

      await recordPrincipalView(id, fx.staffId, { via: "test" }, client);
      const trail = await loadAuditTrail(id, 200, client);
      expect(trail.filter((a) => a.action === "staff_viewed_principal")).toHaveLength(1);
    });
  });

  it("does not write a second entry for the same viewer inside the window", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const id = await person(client, fx, { phone: "9876500508" });

      // A DPO refreshing a page five times is one act of looking. Expressed as
      // a conditional INSERT rather than a read-then-write, so two concurrent
      // renders cannot both pass the check.
      await recordPrincipalView(id, fx.staffId, { via: "test" }, client);
      await recordPrincipalView(id, fx.staffId, { via: "test" }, client);
      await recordPrincipalView(id, fx.staffId, { via: "test" }, client);

      const trail = await loadAuditTrail(id, 200, client);
      expect(trail.filter((a) => a.action === "staff_viewed_principal")).toHaveLength(1);
    });
  });
});
