import { describe, expect, it } from "vitest";
import { claimPrincipal, parseDestination, requestOtp, verifyOtp } from "@/lib/otp";
import { pool } from "@/lib/db";
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

  it("stops sending after three codes to the same destination in fifteen minutes", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Test Person", phone);
      await issue(client, phone);
      await issue(client, phone);
      await issue(client, phone);

      const before = await client.query("SELECT count(*)::int AS n FROM otp_challenge");
      await requestOtp(phone, null, client);
      const after = await client.query("SELECT count(*)::int AS n FROM otp_challenge");

      // The throttle is real - no fourth code goes out.
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  it("answers a throttled real destination exactly as it answers an unknown one", async () => {
    // REGRESSION (R1). The per-destination limit was checked BEFORE the
    // principal lookup, and no challenge row is ever written for a destination
    // that matches nobody - so its count stayed at zero forever and the limit
    // could only ever fire for someone who IS in the register. Four requests
    // and a 429 was a membership test for any phone number in the country,
    // which is Invariant 8 exactly inverted.
    await withRollback(async (client) => {
      const known = uniquePhone();
      const unknown = uniquePhone();
      await makePerson(client, "Real Person", known);

      for (let i = 0; i < 3; i += 1) {
        await requestOtp(known, null, client);
        await requestOtp(unknown, null, client);
      }

      const knownFourth = await requestOtp(known, null, client);
      const unknownFourth = await requestOtp(unknown, null, client);

      // Same shape, same keys, neither rate-limited. The only difference
      // permitted between these two is the random uuid itself.
      expect("rateLimited" in knownFourth).toBe(false);
      expect("rateLimited" in unknownFourth).toBe(false);
      expect(Object.keys(knownFourth).sort()).toEqual(Object.keys(unknownFourth).sort());
    });
  });

  it("still rate limits honestly per IP, which reveals nothing about a destination", async () => {
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Test Person", phone);
      for (let i = 0; i < 10; i += 1) await requestOtp(uniquePhone(), "203.0.113.7", client);
      // Ten challenges from this IP already exist only if they matched someone;
      // seed the count directly so the limit is exercised without depending on
      // how many of those destinations were real.
      await client.query(
        `INSERT INTO otp_challenge (channel, destination_hash, code_hash, matched_principal_ids, expires_at, ip_hash)
         SELECT 'sms', repeat('a', 64), 'x', '{}', now() + interval '5 minutes',
                encode(sha256(('203.0.113.7' || $1)::bytea), 'hex')
           FROM generate_series(1, 10)`,
        [process.env.OTP_PEPPER ?? ""],
      );
      expect(await requestOtp(phone, "203.0.113.7", client)).toEqual({ rateLimited: true });
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

  it("cannot be replayed: a verified single-principal challenge is consumed", async () => {
    // REGRESSION (R2). verifyOtp set verified_at and never consumed_at on the
    // one-person path, so the same six digits minted a fresh 15-minute session
    // for the whole 5-minute TTL. The household path always closed the
    // challenge (claimPrincipal); the ordinary path did not.
    await withRollback(async (client) => {
      const phone = uniquePhone();
      await makePerson(client, "Replay Person", phone);
      const issued = await issue(client, phone);

      expect(await verifyOtp(issued.challengeId, issued.devCode!, null, client))
        .toMatchObject({ ok: true });
      expect(await verifyOtp(issued.challengeId, issued.devCode!, null, client))
        .toEqual({ ok: false });
    });
  });

  it("burns one attempt per concurrent guess, not one in total", async () => {
    // REGRESSION (R5). Every FOR UPDATE in this module ran on the pool, so the
    // lock was released at statement end and N concurrent verifies all read
    // attempts=0 and all wrote attempts=1. MAX_ATTEMPTS capped sequential
    // guessing only.
    //
    // This one cannot use withRollback: work sharing a single client is
    // serialised by pg, which is exactly the condition that hides the bug. It
    // runs on the pool so each verify gets its own connection, and cleans up
    // after itself instead.
    const phone = uniquePhone();
    let principalId: string | undefined;
    let challengeId: string | undefined;
    try {
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO data_principal (full_name, phone_e164) VALUES ($1, $2) RETURNING id",
        ["Concurrent Person", phone],
      );
      principalId = rows[0].id;

      const issued = await requestOtp(phone, null);
      if ("rateLimited" in issued) throw new Error("unexpectedly rate limited");
      challengeId = issued.challengeId;

      const results = await Promise.all(
        Array.from({ length: 4 }, () => verifyOtp(challengeId!, "000000", null)),
      );
      expect(results.every((r) => "ok" in r && r.ok === false)).toBe(true);

      const { rows: after } = await pool.query<{ attempts: number }>(
        "SELECT attempts FROM otp_challenge WHERE id = $1",
        [challengeId],
      );
      // Four simultaneous wrong guesses must cost four of the five attempts.
      // Before the fix this was 1.
      expect(after[0].attempts).toBe(4);
    } finally {
      if (challengeId) {
        await pool.query("DELETE FROM otp_challenge WHERE id = $1", [challengeId]);
      }
      if (principalId) {
        await pool.query("DELETE FROM data_principal WHERE id = $1", [principalId]);
      }
    }
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

  it("rate limits verification per IP, a limit that could not previously fire", async () => {
    // The old threshold compared challenge count against VERIFIES_PER_IP_PER_HOUR
    // * 2 / MAX_ATTEMPTS, i.e. 12 - two above the ceiling of 10 that requestOtp
    // itself enforces - so it was unreachable arithmetic. It now counts actual
    // attempts from audit_log, which is where the verify route already records
    // every otp_failed because that is evidence regardless.
    await withRollback(async (client) => {
      const ip = "203.0.113.42";
      const phone = uniquePhone();
      await makePerson(client, "Test Person", phone);
      const { challengeId } = await issue(client, phone);

      // A wrong code is still refused before the limit bites.
      expect(await verifyOtp(challengeId, "000000", ip, client)).toEqual({ ok: false });

      await client.query(
        `INSERT INTO audit_log (action, actor_type, ip_address)
         SELECT 'otp_failed', 'system', $1::inet FROM generate_series(1, 30)`,
        [ip],
      );

      expect(await verifyOtp(challengeId, "000000", ip, client)).toEqual({ rateLimited: true });
      // A different IP is unaffected: the limit is per caller, not global.
      expect(await verifyOtp(challengeId, "000000", "198.51.100.9", client)).toEqual({ ok: false });
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
