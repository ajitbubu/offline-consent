import { z } from "zod";
import { query } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";

const schema = z.object({
  claimedName: z.string().trim().min(2).max(200),
  contactNote: z.string().trim().min(5).max(2000),
  formReference: z.string().trim().max(200).nullable().default(null),
});

/**
 * The escape hatch for a contact point that was transcribed wrongly.
 *
 * Without this, a typo made while digitising somebody's form silently and
 * permanently blocks their right to withdraw. It files a note for a human; it
 * never confirms or denies whether the person is in the register, because that
 * would be the enumeration oracle the OTP flow is careful to avoid.
 */
export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());

    await query(
      `INSERT INTO principal_lookup_request (claimed_name, contact_note, form_reference)
       VALUES ($1, $2, $3)`,
      [body.claimedName, body.contactNote, body.formReference],
    );

    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
