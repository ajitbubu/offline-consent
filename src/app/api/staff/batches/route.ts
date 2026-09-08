import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { query } from "@/lib/db";
import { MAX_EVIDENCE_BYTES, putEvidence, sniffContentType } from "@/lib/evidence";
import { parseCsv } from "@/lib/bulk";
import { badRequest, errorResponse, json } from "@/lib/http";

/**
 * Starts a batch: stores the CSV as evidence and reads its headers.
 *
 * The file is kept as evidence rather than parsed and thrown away, because the
 * spreadsheet is the source document for every artifact the batch produces - the
 * same reason a scan is kept.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff("dpo");

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return badRequest("No file was uploaded");
    if (file.size > MAX_EVIDENCE_BYTES) return badRequest("That file is larger than 15 MB");

    const bytes = Buffer.from(await file.arrayBuffer());
    const contentType = sniffContentType(bytes, true);
    if (contentType !== "text/csv") return badRequest("That file is not a CSV");

    const preview = parseCsv(bytes.toString("utf8"));
    if (preview.headers.length === 0) return badRequest("That CSV has no header row");
    if (preview.rowCount === 0) return badRequest("That CSV has no rows");

    const evidence = await putEvidence(bytes, {
      kind: "csv_source",
      contentType,
      originalFilename: file.name,
      uploadedBy: staff.staffId,
    });

    const { rows } = await query<{ id: string }>(
      `INSERT INTO intake_batch (source_evidence_id, filename, created_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [evidence.id, file.name.slice(0, 255), staff.staffId],
    );

    return json({ batchId: rows[0].id, ...preview });
  } catch (error) {
    return errorResponse(error);
  }
}
