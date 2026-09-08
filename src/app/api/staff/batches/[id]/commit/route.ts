import { assertSameOrigin, requireStaff } from "@/lib/auth";
import { commitBatch } from "@/lib/bulk";
import { errorResponse, json } from "@/lib/http";

/**
 * Commits every clean row, each in its own transaction (FR-15).
 *
 * Rows that cannot commit stay open in the review queue. In particular a
 * possible duplicate is never resolved here: passing forceNew across ten
 * thousand rows is exactly how one person becomes two records nobody can
 * reconcile, which Invariant 11 exists to prevent.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const staff = await requireStaff("dpo");
    const { id } = await params;
    return json(await commitBatch(id, staff.staffId));
  } catch (error) {
    return errorResponse(error);
  }
}
