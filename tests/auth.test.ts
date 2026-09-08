import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * requireStaff reads an ambient cookie through next/headers, which has no
 * request context in a unit test. Only the cookie value is faked; the token
 * itself is real, signed with the real secret, and verified by the real code.
 */
let staffCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "oc_staff" && staffCookie ? { value: staffCookie } : undefined) }),
}));

const {
  AuthError,
  assertSameOrigin,
  requirePrincipal,
  requireStaff,
  signPrincipalToken,
  signStaffToken,
} = await import("@/lib/auth");
const { pool } = await import("@/lib/db");
const { env } = await import("@/lib/env");

const bearer = (token: string) =>
  new Request("http://localhost:1002/api/portal/consents", {
    headers: { authorization: `Bearer ${token}` },
  });

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  staffCookie = undefined;
  while (cleanup.length) await cleanup.pop()!();
});

async function makeStaff(role = "dpo", isActive = true) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO staff_user (email, password_hash, full_name, role, is_active)
     VALUES ($1, 'x', 'Test Staff', $2, $3) RETURNING id`,
    [`t-${Math.random().toString(36).slice(2, 10)}@example.org`, role, isActive],
  );
  const id = rows[0].id;
  cleanup.push(() => pool.query("DELETE FROM staff_user WHERE id = $1", [id]));
  return id;
}

async function makePrincipal() {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO data_principal (full_name, phone_e164) VALUES ($1, $2) RETURNING id",
    ["Test Principal", `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`],
  );
  const id = rows[0].id;
  // merged_into_id is ON DELETE RESTRICT, so clear any inbound reference first:
  // the merge tests below leave one row pointing at another and cleanup order
  // is not guaranteed to unwind them in the right sequence.
  cleanup.push(async () => {
    await pool.query("UPDATE data_principal SET merged_into_id = NULL WHERE merged_into_id = $1", [id]);
    await pool.query("DELETE FROM data_principal WHERE id = $1", [id]);
  });
  return id;
}

/* -------------------------------------------------------------------------- */

describe("the two credential classes never cross (Invariant 7)", () => {
  it("refuses a staff token at a portal guard", async () => {
    // Without this, a staff session becomes a key to any Data Principal's record.
    const staffId = await makeStaff();
    await expect(requirePrincipal(bearer(signStaffToken(staffId, "dpo")))).rejects.toBeInstanceOf(AuthError);
  });

  it("refuses a principal token at a staff guard", async () => {
    // And without this, a withdrawal link sitting in somebody's mailbox becomes
    // a key to every record in the register.
    const principalId = await makePrincipal();
    staffCookie = signPrincipalToken(principalId);
    await expect(requireStaff()).rejects.toBeInstanceOf(AuthError);
  });

  it("takes a principal's identity from the token subject and nothing else", async () => {
    const principalId = await makePrincipal();
    const request = new Request("http://localhost:1002/api/portal/consents?principalId=someone-else", {
      headers: { authorization: `Bearer ${signPrincipalToken(principalId)}` },
    });
    await expect(requirePrincipal(request)).resolves.toEqual({ principalId });
  });

  it("refuses a request with no credential at all", async () => {
    await expect(requirePrincipal(new Request("http://localhost:1002/x"))).rejects.toBeInstanceOf(AuthError);
    await expect(requireStaff()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("revocation and role", () => {
  it("refuses a token minted in the same second as the cutoff", async () => {
    // iat has one-second resolution, so a token minted in the cutoff second
    // cannot be told apart from one minted just before it. The tie resolves
    // toward refusing, which is the right direction for a register of this kind.
    const staffId = await makeStaff();
    const token = signStaffToken(staffId, "dpo");
    const iat = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).iat as number;
    await pool.query("UPDATE staff_user SET tokens_valid_from = to_timestamp($2) WHERE id = $1", [staffId, iat]);

    staffCookie = token;
    await expect(requireStaff()).rejects.toBeInstanceOf(AuthError);
  });

  it("lets the database role beat a stale role in the token", async () => {
    // A downgrade must take effect on the next call, not whenever the token
    // happens to expire.
    const staffId = await makeStaff("dpo");
    staffCookie = signStaffToken(staffId, "admin");

    await expect(requireStaff("admin")).rejects.toBeInstanceOf(AuthError);
    await expect(requireStaff("dpo")).resolves.toMatchObject({ role: "dpo" });
  });

  it("refuses a deactivated account still holding a valid token", async () => {
    const staffId = await makeStaff("dpo", false);
    staffCookie = signStaffToken(staffId, "dpo");
    await expect(requireStaff()).rejects.toBeInstanceOf(AuthError);
  });

  it("gives a DPO what an operator has", async () => {
    const staffId = await makeStaff("dpo");
    staffCookie = signStaffToken(staffId, "dpo");
    await expect(requireStaff("operator")).resolves.toMatchObject({ staffId, role: "dpo" });
  });
});

describe("a merged identity (Invariant: reads follow the chain)", () => {
  it("resolves a portal session to the surviving person", async () => {
    // merged_into_id was SELECTed here and never read, so a token issued before
    // a DPO merged this person into another kept resolving to the absorbed
    // identity - showing an incomplete record and withdrawing from nothing.
    const absorbed = await makePrincipal();
    const survivor = await makePrincipal();
    await pool.query("UPDATE data_principal SET merged_into_id = $2 WHERE id = $1", [absorbed, survivor]);

    await expect(requirePrincipal(bearer(signPrincipalToken(absorbed)))).resolves.toEqual({
      principalId: survivor,
    });
  });

  it("follows a chain more than one link long", async () => {
    const a = await makePrincipal();
    const b = await makePrincipal();
    const c = await makePrincipal();
    await pool.query("UPDATE data_principal SET merged_into_id = $2 WHERE id = $1", [b, c]);
    await pool.query("UPDATE data_principal SET merged_into_id = $2 WHERE id = $1", [a, b]);

    await expect(requirePrincipal(bearer(signPrincipalToken(a)))).resolves.toEqual({ principalId: c });
  });

  it("refuses a token when the surviving identity has been revoked", async () => {
    const absorbed = await makePrincipal();
    const survivor = await makePrincipal();
    await pool.query("UPDATE data_principal SET merged_into_id = $2 WHERE id = $1", [absorbed, survivor]);

    const token = signPrincipalToken(absorbed);
    const iat = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).iat as number;
    await pool.query("UPDATE data_principal SET portal_tokens_valid_from = to_timestamp($2) WHERE id = $1", [survivor, iat]);

    // Revoking the person must not be defeated by presenting a token minted
    // for the identity that was folded into them.
    await expect(requirePrincipal(bearer(token))).rejects.toBeInstanceOf(AuthError);
  });
});

describe("assertSameOrigin", () => {
  it("accepts the app's own origin", () => {
    const request = new Request("http://x/y", { method: "POST", headers: { origin: env.APP_ORIGIN } });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("refuses another origin", () => {
    const request = new Request("http://x/y", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(() => assertSameOrigin(request)).toThrow(AuthError);
  });

  it("refuses a request with no Origin at all", () => {
    // A same-origin fetch from a browser always sends Origin on a mutating
    // request, so its absence means this did not come from the app.
    expect(() => assertSameOrigin(new Request("http://x/y", { method: "POST" }))).toThrow(AuthError);
  });
});
