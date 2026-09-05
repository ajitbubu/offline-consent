/**
 * Reads of the purpose catalogue and the notice versions. Shared by the intake
 * screens, the review screen and the public portal.
 */
import "server-only";
import { query } from "@/lib/db";

export interface Purpose {
  id: string;
  code: string;
  name: string;
  description: string;
  data_categories: string[];
  display_order: number;
}

export interface NoticeSummary {
  id: string;
  code: string;
  version: number;
  language: string;
  form_label: string;
  purposes: { purpose_id: string; printed_label: string; display_order: number }[];
}

export async function loadPurposes(): Promise<Purpose[]> {
  const { rows } = await query<Purpose>(
    `SELECT id, code, name, description, data_categories, display_order
       FROM purpose WHERE is_active ORDER BY display_order, name`,
  );
  return rows;
}

/**
 * Published notice versions with the exact wording printed beside each
 * tick-box. The reviewer picks the version that matches the paper in front of
 * them, and those printed labels are what get stored verbatim on the artifact.
 */
export async function loadNotices(): Promise<NoticeSummary[]> {
  const { rows } = await query<NoticeSummary>(
    `SELECT n.id, n.code, n.version, n.language, n.form_label,
            COALESCE(
              json_agg(
                json_build_object(
                  'purpose_id', np.purpose_id,
                  'printed_label', np.printed_label,
                  'display_order', np.display_order
                ) ORDER BY np.display_order
              ) FILTER (WHERE np.purpose_id IS NOT NULL),
              '[]'
            ) AS purposes
       FROM consent_notice n
       LEFT JOIN consent_notice_purpose np ON np.notice_id = n.id
      WHERE n.published_at IS NOT NULL
      GROUP BY n.id
      ORDER BY n.code, n.version DESC`,
  );
  return rows;
}
