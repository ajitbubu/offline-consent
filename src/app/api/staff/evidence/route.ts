import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { MAX_EVIDENCE_BYTES, putEvidence, sniffContentType } from "@/lib/evidence";
import { badRequest, errorResponse, json } from "@/lib/http";

const KINDS = new Set(["scan", "signature", "csv_source"]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff();

    const form = await request.formData();
    const file = form.get("file");
    const kind = String(form.get("kind") ?? "scan");

    if (!(file instanceof File)) return badRequest("No file was uploaded");
    if (!KINDS.has(kind)) return badRequest("Unknown evidence kind");
    if (file.size > MAX_EVIDENCE_BYTES) {
      return badRequest("That file is larger than 15 MB");
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    // From the bytes, never from file.type - the browser's Content-Type is
    // supplied by whoever built the request.
    const contentType = sniffContentType(bytes, kind === "csv_source");
    if (!contentType) {
      return badRequest("That file is not a JPEG, PNG, PDF or CSV");
    }
    if (kind === "csv_source" && contentType !== "text/csv") {
      return badRequest("A bulk import source must be a CSV file");
    }
    if (kind !== "csv_source" && contentType === "text/csv") {
      return badRequest("A scan must be an image or a PDF");
    }

    const evidence = await putEvidence(bytes, {
      kind: kind as "scan" | "signature" | "csv_source",
      contentType,
      originalFilename: file.name,
      uploadedBy: staff.staffId,
    });

    return json({
      id: evidence.id,
      contentType: evidence.content_type,
      filename: evidence.original_filename,
      byteSize: Number(evidence.byte_size),
      sha256: evidence.sha256,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
