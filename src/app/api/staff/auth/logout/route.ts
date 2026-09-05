import { clearStaffCookie } from "@/lib/auth";
import { errorResponse, json } from "@/lib/http";

export async function POST() {
  try {
    await clearStaffCookie();
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
