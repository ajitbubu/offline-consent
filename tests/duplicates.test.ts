import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { confidenceOf, findDuplicates } from "@/lib/duplicates";
import { withRollback } from "./helpers/db";

async function person(
  client: PoolClient,
  name: string,
  contact: { phone?: string; email?: string },
) {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO data_principal (full_name, phone_e164, email) VALUES ($1,$2,$3) RETURNING id",
    [name, contact.phone ?? null, contact.email ?? null],
  );
  return rows[0].id;
}

const pairFor = async (client: PoolClient, a: string, b: string) => {
  const found = await findDuplicates(client);
  return found.find(
    (p) => (p.a_id === a && p.b_id === b) || (p.a_id === b && p.b_id === a),
  );
};

describe("findDuplicates", () => {
  it("finds one person split across a phone and an email", async () => {
    // The structural case: identity is (contact point, name), so a form carrying
    // a phone and a form carrying an email never match each other's index and
    // nothing links them at all. The portal resolves one contact point, so the
    // second identity's consents cannot be withdrawn by anybody.
    await withRollback(async (client) => {
      const a = await person(client, "Rajesh Venkataraman", { phone: "+919876590001" });
      const b = await person(client, "Rajesh Venkatraman", { email: "rajesh.v@example.org" });

      const pair = await pairFor(client, a, b);
      expect(pair).toBeDefined();
      expect(pair!.reason).toBe("similar_name_split_contact");
      expect(pair!.shares_contact).toBe(false);
      expect(confidenceOf(pair!).tone).toBe("amber");
    });
  });

  it("flags a transcription variant on the same contact point as very likely", async () => {
    await withRollback(async (client) => {
      const a = await person(client, "Lakshmi Narayanan", { phone: "+919876590002" });
      const b = await person(client, "Lakshmi Narayanann", { phone: "+919876590002" });

      const pair = await pairFor(client, a, b);
      expect(pair).toBeDefined();
      expect(pair!.shares_contact).toBe(true);
      const confidence = confidenceOf(pair!);
      expect(confidence.tone).toBe("red");
      expect(confidence.label).toMatch(/same person/i);
    });
  });

  it("does not call a shared household phone a duplicate", async () => {
    // The case the uniqueness rule was designed for. A report that flags every
    // household trains a DPO to dismiss the list, and merging two real people is
    // the one mistake nothing can undo.
    await withRollback(async (client) => {
      const a = await person(client, "Arun Pillai", { phone: "+919876590003" });
      const b = await person(client, "Meera Pillai", { phone: "+919876590003" });

      expect(await pairFor(client, a, b)).toBeUndefined();
    });
  });

  it("does not pair two unrelated people who happen to share a surname", async () => {
    await withRollback(async (client) => {
      const a = await person(client, "Sanjay Gupta", { phone: "+919876590004" });
      const b = await person(client, "Ritu Gupta", { email: "ritu@example.org" });

      expect(await pairFor(client, a, b)).toBeUndefined();
    });
  });

  it("leaves an already-merged identity out of the list", async () => {
    // It has been dealt with. Showing it again is asking a DPO to re-decide
    // something they already decided.
    await withRollback(async (client) => {
      const a = await person(client, "Deepak Chandran", { phone: "+919876590005" });
      const b = await person(client, "Deepak Chandra", { phone: "+919876590005" });
      expect(await pairFor(client, a, b)).toBeDefined();

      await client.query("UPDATE data_principal SET merged_into_id = $2 WHERE id = $1", [a, b]);
      expect(await pairFor(client, a, b)).toBeUndefined();
    });
  });

  it("reports each pair once, not twice", async () => {
    await withRollback(async (client) => {
      const a = await person(client, "Ishaan Malhotra", { phone: "+919876590006" });
      const b = await person(client, "Ishan Malhotra", { phone: "+919876590006" });

      const found = await findDuplicates(client);
      const both = found.filter(
        (p) => (p.a_id === a && p.b_id === b) || (p.a_id === b && p.b_id === a),
      );
      expect(both).toHaveLength(1);
    });
  });
});
