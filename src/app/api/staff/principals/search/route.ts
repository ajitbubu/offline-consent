import { requireStaff } from "@/lib/auth";
import { searchPrincipals } from "@/lib/register";
import { errorResponse, json } from "@/lib/http";

/** Typeahead for the merge picker. DPO only, same gate as the register itself. */
export async function GET(request: Request) {
  try {
    await requireStaff("dpo");
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const results = await searchPrincipals(q);
    return json({
      results: results.map((p) => ({
        id: p.id,
        fullName: p.full_name,
        contact: [p.phone_e164, p.email].filter(Boolean).join(" · "),
        artifacts: p.artifacts,
        merged: p.merged_into_id !== null,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
