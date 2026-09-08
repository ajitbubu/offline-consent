import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuthError } from "@/lib/auth";
import { badRequest, errorResponse, json } from "@/lib/http";

describe("json and badRequest", () => {
  it("defaults to 200 and carries the body through", async () => {
    const r = json({ ok: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("always gives badRequest a fields object, so callers need not guard it", async () => {
    const r = badRequest("nope");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "nope", fields: {} });
  });
});

describe("errorResponse", () => {
  it("passes an AuthError's status and message through", async () => {
    const r = errorResponse(new AuthError(403, "Cross-origin request refused"));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "Cross-origin request refused" });
  });

  it("turns a ZodError into a 400 with per-field messages", async () => {
    const schema = z.object({ name: z.string().min(2, "Too short") });
    let thrown: unknown;
    try {
      schema.parse({ name: "" });
    } catch (e) {
      thrown = e;
    }
    const r = errorResponse(thrown);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; fields: Record<string, string> };
    expect(body.error).toBe("Validation failed");
    expect(body.fields.name).toBe("Too short");
  });

  it("never leaks an unexpected error to the client", async () => {
    // The whole reason this helper exists: a stack trace or a Postgres message
    // reaching the browser from an app holding consent evidence is a disclosure,
    // so anything unrecognised has to come back as a bare 500.
    const r = errorResponse(new Error("relation \"consent_artifact\" does not exist"));
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("Something went wrong");
    expect(JSON.stringify(body)).not.toContain("consent_artifact");
  });

  it("does not leak a thrown string or object either", async () => {
    for (const weird of ["boom", { code: "42P01" }, null, undefined]) {
      const r = errorResponse(weird);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "Something went wrong" });
    }
  });
});
