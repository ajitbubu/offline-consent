import { requireStaff } from "@/lib/auth";
import { query } from "@/lib/db";
import { clientIp, userAgent, writeAudit } from "@/lib/audit";
import { getEvidenceBytes } from "@/lib/evidence";
import { errorResponse, json } from "@/lib/http";
import { roleAtLeast } from "@/lib/consent";

/**
 * Evidence is served only through this handler, never as a static file.
 *
 * Access narrows after withdrawal: once a person has withdrawn everything, an
 * operator has no remaining reason to open their scan, so only a DPO may.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const staff = await requireStaff();
    const { id } = await params;

    const { rows } = await query<{
      storage_key: string;
      content_type: string;
      original_filename: string;
      deleted_at: Date | null;
      fully_withdrawn: boolean;
      data_principal_id: string | null;
    }>(
      `SELECT e.storage_key,
              e.content_type,
              e.original_filename,
              e.deleted_at,
              a.data_principal_id,
              COALESCE(
                (SELECT bool_and(r.status = 'withdrawn')
                   FROM consent_record r
                  WHERE r.data_principal_id = a.data_principal_id),
                false
              ) AS fully_withdrawn
         FROM evidence_object e
         LEFT JOIN consent_artifact a
           ON a.evidence_id = e.id OR a.signature_evidence_id = e.id
        WHERE e.id = $1
        LIMIT 1`,
      [id],
    );

    const evidence = rows[0];
    if (!evidence) return json({ error: "Not found" }, 404);
    if (evidence.deleted_at) return json({ error: "This evidence has been destroyed" }, 410);

    if (evidence.fully_withdrawn && !roleAtLeast(staff.role, "dpo")) {
      return json(
        { error: "This person has withdrawn their consent. Only a DPO may open the evidence." },
        403,
      );
    }

    const bytes = await getEvidenceBytes(evidence.storage_key);

    await writeAudit({
      action: "evidence_accessed",
      actorType: "staff",
      actorId: staff.staffId,
      dataPrincipalId: evidence.data_principal_id,
      newState: { evidenceId: id },
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
    });

    const inline = new URL(request.url).searchParams.get("inline") === "1";

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": evidence.content_type,
        "content-length": String(bytes.length),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(evidence.original_filename)}"`,
        // A crafted PDF or SVG must not be able to run script in the staff
        // origin and ride the session cookie.
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
