import { requireStaff } from "@/lib/auth";
import { corpusStatus, exportTrainingSet } from "@/lib/training";
import { errorResponse, json } from "@/lib/http";

/**
 * The training set as JSONL, one example per line.
 *
 * A download rather than a file on disk: this is every scanned form's OCR text
 * paired with a confirmed name, phone number and email, which is about as
 * sensitive as anything in the register. It goes to a named DPO over an
 * authenticated request, not to a directory somebody might later serve.
 */
export async function GET(request: Request) {
  try {
    await requireStaff("dpo");

    const status = await corpusStatus();
    if (new URL(request.url).searchParams.get("status") === "1") {
      return json(status);
    }

    const examples = await exportTrainingSet();
    const body = examples.map((e) => JSON.stringify(e)).join("\n");

    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="training-${new Date().toISOString().slice(0, 10)}.jsonl"`,
        // Never cached anywhere: it is personal data with a filename.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
