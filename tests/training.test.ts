import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { commitDraft } from "@/lib/intake";
import { corpusStatus, exportTrainingSet, CORPUS_TARGET } from "@/lib/training";
import { seedFixture, withRollback, type Fixture } from "./helpers/db";

const tokensFor = (words: string[]) => ({
  schemaVersion: 1,
  engine: "tesseract",
  engineVersion: "5.5.3",
  capturedAt: new Date().toISOString(),
  pages: [
    {
      page: 1,
      width: 1700,
      height: 2200,
      tokens: words.map((text, i) => ({
        text,
        bbox: [100 + i * 90, 300, 180 + i * 90, 330] as [number, number, number, number],
        confidence: 0.95,
      })),
    },
  ],
});

/** A committed draft carrying OCR tokens - one trainable pair. */
async function trainablePair(client: PoolClient, fx: Fixture, words: string[], name: string) {
  const payload = {
    principal: { fullName: name, phone: "9876560001", phoneE164: null, email: null },
    noticeId: fx.noticeId,
    noticeAtCollection: "printed_on_form",
    collectedOn: "2019-03-04",
    collectedOnPrecision: "day",
    collectionLocation: null,
    subjectDeclaration: null,
    items: fx.purposeIds.map((purposeId, i) => ({
      purposeId,
      granted: true,
      verbatimLabel: fx.labels[i],
    })),
  };
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO intake_draft (source, payload, ocr_tokens, created_by)
     VALUES ('scan', $1, $2, $3) RETURNING id`,
    [JSON.stringify(payload), JSON.stringify(tokensFor(words)), fx.staffId],
  );
  await commitDraft({ draftId: rows[0].id, staffId: fx.staffId }, client);
  return rows[0].id;
}

describe("corpusStatus", () => {
  it("counts committed drafts that carry tokens, and the ones that do not", async () => {
    // The number is the point. "Text extraction waits for fifty real scans" is
    // unfalsifiable until somebody can see it, and an invisible dependency is
    // how a blocker quietly becomes an excuse.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const before = await corpusStatus(client);

      await trainablePair(client, fx, ["Priya", "Sharma", "98765", "43210"], "Priya Sharma");

      const after = await corpusStatus(client);
      expect(after.pairs).toBe(before.pairs + 1);
      expect(after.target).toBe(CORPUS_TARGET);
    });
  });
});

describe("exportTrainingSet", () => {
  it("pairs the tokens with the payload a human confirmed", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const draftId = await trainablePair(
        client,
        fx,
        ["Full", "name", "Priya", "Sharma", "Mobile", "9876560001"],
        "Priya Sharma",
      );

      const examples = await exportTrainingSet(5000, client);
      const mine = examples.find((e) => e.draftId === draftId);

      expect(mine).toBeDefined();
      expect(mine!.engine).toBe("tesseract");
      expect(mine!.pages[0].tokens.length).toBe(6);
      expect(mine!.artifactId).not.toBeNull();
    });
  });

  it("locates a name spanning two tokens and gives its box", async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const draftId = await trainablePair(
        client,
        fx,
        ["Full", "name", "Priya", "Sharma", "Mobile"],
        "Priya Sharma",
      );

      const mine = (await exportTrainingSet(5000, client)).find((e) => e.draftId === draftId)!;
      const label = mine.labels.find((l) => l.field === "fullName")!;

      expect(label.tokenIndices).toEqual([2, 3]);
      expect(label.page).toBe(1);
      expect(label.bbox).not.toBeNull();
    });
  });

  it("returns a null span rather than a guessed one when the value is not on the page", async () => {
    // A fuzzy match here would mint labels that look like ground truth and are
    // not, and a model trained on those learns the matcher's mistakes rather
    // than the form's layout.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const draftId = await trainablePair(
        client,
        fx,
        ["Some", "entirely", "different", "words"],
        "Priya Sharma",
      );

      const mine = (await exportTrainingSet(5000, client)).find((e) => e.draftId === draftId)!;
      const label = mine.labels.find((l) => l.field === "fullName")!;

      expect(label.value).toBe("Priya Sharma");
      expect(label.tokenIndices).toBeNull();
      expect(label.bbox).toBeNull();
    });
  });

  it("does not export a draft that was never committed", async () => {
    // The pair is only a training pair once a human has confirmed it against the
    // paper. An unreviewed draft is the model's own guess.
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const payload = {
        principal: { fullName: "Not Reviewed", phone: "9876560002", phoneE164: null, email: null },
        noticeId: fx.noticeId,
        noticeAtCollection: "printed_on_form",
        collectedOn: "2019-03-04",
        collectedOnPrecision: "day",
        collectionLocation: null,
        subjectDeclaration: null,
        items: [{ purposeId: fx.purposeIds[0], granted: true, verbatimLabel: fx.labels[0] }],
      };
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO intake_draft (source, payload, ocr_tokens, created_by)
         VALUES ('scan', $1, $2, $3) RETURNING id`,
        [JSON.stringify(payload), JSON.stringify(tokensFor(["Not", "Reviewed"])), fx.staffId],
      );

      const examples = await exportTrainingSet(5000, client);
      expect(examples.find((e) => e.draftId === rows[0].id)).toBeUndefined();
    });
  });
});
