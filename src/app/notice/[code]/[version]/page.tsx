import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";
import { query } from "@/lib/db";

interface NoticeRow {
  title: string;
  body: string;
  form_label: string;
  fiduciary_contact: string;
  version: number;
  published_at: Date | null;
  purposes: { printed_label: string; name: string; data_categories: string[] }[];
}

async function loadNotice(code: string, version: string): Promise<NoticeRow | null> {
  const parsed = Number(version);
  if (!Number.isInteger(parsed) || parsed < 1) return null;

  const { rows } = await query<NoticeRow>(
    `SELECT n.title, n.body, n.form_label, n.fiduciary_contact, n.version, n.published_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'printed_label', np.printed_label,
                  'name', p.name,
                  'data_categories', p.data_categories
                ) ORDER BY np.display_order
              ) FILTER (WHERE np.purpose_id IS NOT NULL),
              '[]'
            ) AS purposes
       FROM consent_notice n
       LEFT JOIN consent_notice_purpose np ON np.notice_id = n.id
       LEFT JOIN purpose p ON p.id = np.purpose_id
      WHERE n.code = $1 AND n.version = $2 AND n.published_at IS NOT NULL
      GROUP BY n.id`,
    [code, parsed],
  );
  return rows[0] ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string; version: string }>;
}): Promise<Metadata> {
  const { code, version } = await params;
  const notice = await loadNotice(code, version);
  return { title: notice?.form_label ?? "Notice" };
}

/**
 * The public, versioned notice text. This is what a s.5(2) delivery links to,
 * so it must stay readable without an account and must never change under a
 * given version number.
 */
export default async function NoticePage({
  params,
}: {
  params: Promise<{ code: string; version: string }>;
}) {
  const { code, version } = await params;
  const notice = await loadNotice(code, version);
  if (!notice) notFound();

  return (
    <PublicShell>
      <p className="text-sm text-muted">{notice.form_label}</p>
      <h1 className="mt-1 text-xl font-semibold text-ink">{notice.title}</h1>

      <div className="mt-6 flex flex-col gap-4 text-ink">
        {notice.body.split("\n\n").map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>

      {notice.purposes.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-ink">
            What you were asked to agree to
          </h2>
          <ul className="mt-3 flex flex-col divide-y divide-line border-y border-line">
            {notice.purposes.map((purpose, i) => (
              <li key={i} className="py-3">
                <p className="text-sm text-ink">{purpose.printed_label}</p>
                {purpose.data_categories.length > 0 && (
                  <p className="mt-0.5 text-xs text-muted">
                    Covers: {purpose.data_categories.join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-10 rounded-md bg-canvas px-4 py-3 text-sm text-muted">
        Questions or complaints: {notice.fiduciary_contact}
      </p>
    </PublicShell>
  );
}
