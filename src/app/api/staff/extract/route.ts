import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { query } from "@/lib/db";
import { clientIp, userAgent, writeAudit } from "@/lib/audit";
import { extract, extractionConfigured, labelsForNotice } from "@/lib/extraction";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  evidenceId: z.string().uuid(),
  // When the reviewer has already identified the printed form, its tick-box
  // wording is what the service anchors on. Without it we still bank the tokens.
  noticeId: z.string().uuid().nullable().default(null),
});

/**
 * Runs a scan through the extraction service.
 *
 * Always answers 200 with whatever it managed to get. Extraction being
 * unavailable is not an error the reviewer needs to act on - it means the review
 * screen is the manual entry form, which is what it is anyway.
 *
 * The tokens returned here are passed back when the draft is created, so that
 * the pair (tokens, human-verified payload) lands on one row. That pair IS the
 * training set for text extraction, and it is the reason to run OCR now rather
 * than when the model is built: every scan reviewed without it is a label lost.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff();
    const { evidenceId, noticeId } = schema.parse(await request.json());

    if (!extractionConfigured()) {
      return json({ available: false, ocrTokens: null, extraction: null });
    }

    const { rows } = await query<{
      id: string;
      storage_key: string;
      content_type: string;
      deleted_at: Date | null;
    }>(
      "SELECT id, storage_key, content_type, deleted_at FROM evidence_object WHERE id = $1",
      [evidenceId],
    );
    const evidence = rows[0];
    if (!evidence || evidence.deleted_at !== null) {
      return json({ error: "That evidence is not available" }, 404);
    }

    const labels = noticeId === null ? [] : await labelsForNotice(noticeId);

    const result = await extract(
      {
        id: evidence.id,
        storageKey: evidence.storage_key,
        contentType: evidence.content_type,
      },
      labels,
    );

    if (result === null) {
      return json({ available: false, ocrTokens: null, extraction: null });
    }

    await writeAudit({
      action: "extraction_performed",
      actorType: "staff",
      actorId: staff.staffId,
      newState: {
        evidenceId,
        noticeId,
        engine: result.ocrTokens.engine,
        engineVersion: result.ocrTokens.engineVersion,
        pages: result.ocrTokens.pages.length,
        tokens: result.ocrTokens.pages.reduce((n, p) => n + p.tokens.length, 0),
        // What the model proposed, recorded before any human touched it - so a
        // later argument about what was suggested versus what was accepted has
        // an answer.
        tickboxes: result.extraction?.tickboxes.map((t) => ({
          purposeId: t.purposeId,
          granted: t.granted,
          confidence: t.confidence,
        })) ?? [],
      },
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
    });

    return json({ available: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
