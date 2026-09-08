import { z } from "zod";
import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { query, withTransaction } from "@/lib/db";
import { buildDrafts, columnMappingSchema, loadBatchText } from "@/lib/bulk";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  mapping: columnMappingSchema,
  noticeId: z.string().uuid().nullable().default(null),
});

/** Applies the mapping and turns every row into a reviewable draft. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff("dpo");
    const { id } = await params;
    const body = schema.parse(await request.json());

    const { rows: batch } = await query<{ storage_key: string; status: string }>(
      `SELECT e.storage_key, b.status
         FROM intake_batch b JOIN evidence_object e ON e.id = b.source_evidence_id
        WHERE b.id = $1`,
      [id],
    );
    if (batch.length === 0) return json({ error: "No such batch" }, 404);
    if (batch[0].status !== "mapping") {
      return json({ error: "This batch has already been mapped" }, 409);
    }

    const { rows: purposes } = await query<{ id: string; code: string; name: string }>(
      "SELECT id, code, name FROM purpose WHERE is_active ORDER BY display_order, name",
    );
    const text = await loadBatchText(batch[0].storage_key);

    const report = await withTransaction((client) =>
      buildDrafts(
        {
          batchId: id,
          text,
          mapping: body.mapping,
          noticeId: body.noticeId,
          staffId: staff.staffId,
          purposes: purposes.map((p) => ({ id: p.id, code: p.code, label: p.name })),
        },
        client,
      ),
    );

    return json({
      rows: report.length,
      clean: report.filter((r) => !r.issues.some((i) => i.severity === "error")).length,
      report: report.slice(0, 200),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
