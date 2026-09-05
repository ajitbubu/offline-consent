import { requirePrincipal } from "@/lib/auth";
import { query } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";

/**
 * The person's own consent record.
 *
 * The identity comes from the token's subject and from nowhere else - this
 * handler accepts no id in the path, the query string or a body.
 */
export async function GET(request: Request) {
  try {
    const { principalId } = await requirePrincipal(request);

    const { rows } = await query<{
      purpose_id: string;
      name: string;
      description: string;
      data_categories: string[];
      status: string;
      consent_given_on: string | null;
      withdrawn_at: Date | null;
      form_label: string | null;
      notice_code: string | null;
      notice_version: number | null;
    }>(
      `SELECT r.purpose_id,
              p.name,
              p.description,
              p.data_categories,
              r.status,
              r.consent_given_on,
              r.withdrawn_at,
              n.form_label,
              n.code    AS notice_code,
              n.version AS notice_version
         FROM consent_record r
         JOIN purpose p          ON p.id = r.purpose_id
         JOIN consent_artifact a ON a.id = r.source_artifact_id
         LEFT JOIN consent_notice n ON n.id = a.notice_id
        WHERE r.data_principal_id = $1
        ORDER BY p.display_order, p.name`,
      [principalId],
    );

    const { rows: person } = await query<{ full_name: string }>(
      "SELECT full_name FROM data_principal WHERE id = $1",
      [principalId],
    );

    return json({
      fullName: person[0]?.full_name ?? null,
      consents: rows.map((r) => ({
        purposeId: r.purpose_id,
        name: r.name,
        description: r.description,
        dataCategories: r.data_categories,
        status: r.status,
        givenOn: r.consent_given_on,
        withdrawnAt: r.withdrawn_at?.toISOString() ?? null,
        formLabel: r.form_label,
        noticeHref:
          r.notice_code && r.notice_version
            ? `/notice/${r.notice_code}/${r.notice_version}`
            : null,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
