import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// env validates at import time and ML_SERVICE_URL is optional, so the URL has to
// be set before ANY static import reaches @/lib/env. helpers/db imports @/lib/db
// which imports env, so it has to come in dynamically below rather than at the
// top of the file - a static import would be hoisted above this assignment and
// env would be parsed without it.
process.env.ML_SERVICE_URL = "http://ml.test";

vi.mock("@/lib/evidence", () => ({
  getEvidenceBytes: vi.fn(async () => Buffer.from("fake-scan-bytes")),
}));

const { seedFixture, withRollback } = await import("./helpers/db");
const { EXTRACTION_SCHEMA_VERSION } = await import("@/lib/consent");
const { extract, extractionConfigured, labelsForNotice } = await import("@/lib/extraction");

const EVIDENCE = { id: "e1", storageKey: "2026/09/abc", contentType: "image/png" };

const serviceBody = (tickboxes: unknown[] = []) => ({
  schema_version: 1,
  engine: "tesseract",
  engine_version: "5.5.3",
  pages: [
    {
      page: 1,
      width: 1700,
      height: 2200,
      tokens: [{ text: "marketing", bbox: [10, 20, 90, 45], confidence: 0.96 }],
    },
  ],
  tickboxes,
});

const reading = (index: number, granted: boolean | null) => ({
  index,
  granted,
  confidence: 0.9,
  anchor_score: 0.97,
  ink_ratio: granted ? 0.55 : 0.0,
  page: 1,
  bbox: [150, 460, 196, 506],
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("extract", () => {
  it("is configured when ML_SERVICE_URL is set", () => {
    expect(extractionConfigured()).toBe(true);
  });

  it("banks self-describing tokens even with no labels to anchor on", async () => {
    // Token capture must not depend on a notice version being chosen: the
    // corpus is the urgent part and it is notice-independent.
    fetchMock.mockResolvedValue(ok(serviceBody()));

    const result = await extract(EVIDENCE, []);

    expect(result).not.toBeNull();
    expect(result!.extraction).toBeNull();
    expect(result!.ocrTokens.schemaVersion).toBe(EXTRACTION_SCHEMA_VERSION);
    expect(result!.ocrTokens.engine).toBe("tesseract");
    // Page geometry travels with the tokens; without it a bbox means nothing.
    expect(result!.ocrTokens.pages[0]).toMatchObject({ page: 1, width: 1700, height: 2200 });
  });

  it("never sends a database identifier, only an index", async () => {
    // PRD SEC-9: the extraction model never chooses a database identifier.
    fetchMock.mockResolvedValue(ok(serviceBody()));

    await extract(EVIDENCE, [
      { purposeId: "11111111-1111-1111-1111-111111111111", text: "I agree to marketing" },
    ]);

    const body = fetchMock.mock.calls[0][1].body as FormData;
    const sent = JSON.parse(body.get("labels") as string);
    expect(sent).toEqual([{ index: 0, text: "I agree to marketing" }]);
    expect(JSON.stringify(sent)).not.toContain("1111");
  });

  it("maps readings back onto the purposes it asked about", async () => {
    const labels = [
      { purposeId: "aaaaaaaa-0000-0000-0000-000000000001", text: "Marketing" },
      { purposeId: "bbbbbbbb-0000-0000-0000-000000000002", text: "Partners" },
    ];
    fetchMock.mockResolvedValue(ok(serviceBody([reading(1, true), reading(0, false)])));

    const result = await extract(EVIDENCE, labels);

    const byPurpose = Object.fromEntries(
      result!.extraction!.tickboxes.map((t) => [t.purposeId, t.granted]),
    );
    expect(byPurpose[labels[0].purposeId]).toBe(false);
    expect(byPurpose[labels[1].purposeId]).toBe(true);
  });

  it("drops a reading for an index it never sent", async () => {
    // The defence that makes SEC-9 hold in both directions: a confused or
    // compromised service cannot name a purpose we did not ask about.
    const labels = [{ purposeId: "aaaaaaaa-0000-0000-0000-000000000001", text: "Marketing" }];
    fetchMock.mockResolvedValue(ok(serviceBody([reading(0, true), reading(7, true)])));

    const result = await extract(EVIDENCE, labels);

    expect(result!.extraction!.tickboxes).toHaveLength(1);
    expect(result!.extraction!.tickboxes[0].purposeId).toBe(labels[0].purposeId);
  });

  it("keeps 'label not found' distinct from 'box is empty'", async () => {
    const labels = [{ purposeId: "aaaaaaaa-0000-0000-0000-000000000001", text: "Marketing" }];
    fetchMock.mockResolvedValue(ok(serviceBody([reading(0, null)])));

    const result = await extract(EVIDENCE, labels);
    expect(result!.extraction!.tickboxes[0].granted).toBeNull();
  });

  it.each([
    ["a non-2xx response", () => ({ ok: false, status: 503, text: async () => "down" })],
    ["an unreachable service", () => { throw new Error("ECONNREFUSED"); }],
    ["a malformed body", () => ({ ok: true, status: 200, json: async () => ({ nope: true }) })],
  ])("returns null on %s rather than failing the reviewer", async (_label, behaviour) => {
    // Extraction being unavailable means the review screen is the manual entry
    // form, which is the same screen. One degradation path, not two.
    fetchMock.mockImplementation(async () => behaviour() as unknown as Response);
    await expect(extract(EVIDENCE, [])).resolves.toBeNull();
  });
});

describe("labelsForNotice", () => {
  it("returns the printed wording in the order it appears on the form", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const labels = await labelsForNotice(fx.noticeId, client);

      expect(labels.map((l) => l.text)).toEqual(fx.labels);
      expect(labels.map((l) => l.purposeId)).toEqual(fx.purposeIds);
    });
  });
});
