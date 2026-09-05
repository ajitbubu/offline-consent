import { describe, expect, it } from "vitest";
import { claimPrincipal, parseDestination, requestOtp, verifyOtp } from "@/lib/otp";
import { withRollback } from "./helpers/db";
import type { PoolClient } from "pg";

/** The dev echo puts the code in the result; production never returns it. */
async function issue(client: PoolClient, destination: string) {
  const result = await requestOtp(destination, null, client);
  if ("rateLimited" in result) throw new Error("unexpectedly rate limited");
  return result;
}

async function makePerson(client: PoolClient, name: string, phone: string) {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO data_principal (full_name, phone_e164) VALUES ($1, $2) RETURNING id",
    [name, phone],
  );
  return rows[0].id;
}

const uniquePhone = () =>
  `+9198${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;

describe("parseDestination", () => {
  it("accepts either a phone number or an email, and rejects anything else", () => {
    expect(parseDestination("98765 43210")).toEqual({
      channel: "sms",
      value: "+919876543210",
    });
    expect(parseDestination("  Person@Example.ORG ")).toEqual({
      channel: "email",
      value: "person@example.org",
    });
    expect(parseDestination("not a contact point")).toBeNull();
    expect(parseDestination("12345")).toBeNull();
  });
});

describe("requestOtp", () => {
  it("stores nothing for a destination that matches nobody", async () => {
    await withRollback(async (client) => {
      const before = await client.query("SELECT count(*)::int AS n FROM otp_challenge");
      const result = await issue(client, uniquePhone());
      const after = await client.query("SELECT count(*)::int AS n FROM otp_challenge");

      // A challenge id comes back regardless, so the caller cannot tell.
      expect(result.challengeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  it("issues a code when the contact point is on a form we hold", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Test Person", phone);
      const result = await issue(client, phone);
      expect(result.devCode).toMatch(/^\d{6}$/);
    });
  });

  it("kills the previous challenge when a new code is requested", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Test Person", phone);

      const first = await issue(client, phone);
      const second = await issue(client, phone);

      // Without this an attacker requests many codes and sprays a few guesses at
      // each, and the per-challenge attempt cap buys nothing.
      const stale = await verifyOtp(first.challengeId, first.devCode!, null, client);
      expect(stale).toEqual({ ok: false });

      const live = await verifyOtp(second.challengeId, second.devCode!, null, client);
      expect(live).toMatchObject({ ok: true });
    });
  });

  it("stops after three sends to the same destination in fifteen minutes", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Test Person", phone);
      await issue(client, phone);
      await issue(client, phone);
      await issue(client, phone);
      expect(await requestOtp(phone, null, client)).toEqual({ rateLimited: true });
    });
  });
});

describe("verifyOtp", () => {
  it("dies after five wrong codes, and the real code no longer works", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Test Person", phone);
      const { challengeId, devCode } = await issue(client, phone);

      for (let i = 0; i < 5; i += 1) {
        expect(await verifyOtp(challengeId, "000000", null, client)).toEqual({ ok: false });
      }

      const { rows } = await client.query(
        "SELECT attempts, consumed_at FROM otp_challenge WHERE id = $1",
        [challengeId],
      );
      expect(rows[0].attempts).toBe(5);
      expect(rows[0].consumed_at).not.toBeNull();

      expect(await verifyOtp(challengeId, devCode!, null, client)).toEqual({ ok: false });
    });
  });

  it("counts every wrong attempt", async () => {
    // Regression: the UPDATE that increments this used an uncast parameter both
    // as the assigned integer and in a comparison, which Postgres rejects with
    // 42P08. The failure surfaced as a 500 and the counter never moved, so the
    // brute-force cap was silently absent.
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Test Person", phone);
      const { challengeId } = await issue(client, phone);

      await verifyOtp(challengeId, "000000", null, client);
      const { rows } = await client.query(
        "SELECT attempts FROM otp_challenge WHERE id = $1",
        [challengeId],
      );
      expect(rows[0].attempts).toBe(1);
    });
  });

  it("refuses an expired challenge", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Test Person", phone);
      const { challengeId, devCode } = await issue(client, phone);

      await client.query(
        "UPDATE otp_challenge SET expires_at = now() - interval '1 second' WHERE id = $1",
        [challengeId],
      );
      expect(await verifyOtp(challengeId, devCode!, null, client)).toEqual({ ok: false });
    });
  });

  it("answers identically for a challenge id that never existed", async () => {
    await withRollback(async (client) => {
      const result = await verifyOtp(
        "00000000-0000-4000-8000-000000000000",
        "123456",
        null,
        client,
      );
      expect(result).toEqual({ ok: false });
    });
  });

  it("returns every person sharing a contact point", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      const a = await makePerson(client, "Ravi Menon", phone);
      const b = await makePerson(client, "Meera Menon", phone);

      const { challengeId, devCode } = await issue(client, phone);
      const result = await verifyOtp(challengeId, devCode!, null, client);

      expect(result).toMatchObject({ ok: true });
      if ("principalIds" in result) {
        expect(result.principalIds.sort()).toEqual([a, b].sort());
      }
    });
  });
});

describe("claimPrincipal", () => {
  it("refuses a principal that was not on the challenge", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Ravi Menon", phone);
      await makePerson(client, "Meera Menon", phone);
      const stranger = await makePerson(client, "Someone Else", uniquePhone());

      const { challengeId, devCode } = await issue(client, phone);
      await verifyOtp(challengeId, devCode!, null, client);

      // The client supplies an id here, so it is checked against the set frozen
      // when the code was sent rather than trusted.
      expect(await claimPrincipal(challengeId, stranger, client)).toBe(false);
    });
  });

  it("accepts one of the challenge's own people, then closes the challenge", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      const a = await makePerson(client, "Ravi Menon", phone);
      await makePerson(client, "Meera Menon", phone);

      const { challengeId, devCode } = await issue(client, phone);
      await verifyOtp(challengeId, devCode!, null, client);

      expect(await claimPrincipal(challengeId, a, client)).toBe(true);
      expect(await claimPrincipal(challengeId, a, client)).toBe(false);
    });
  });
});
