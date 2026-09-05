import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { loadNotices, loadPurposes } from "@/lib/catalogue";
import { ImportClient } from "@/components/import-client";

export const metadata: Metadata = { title: "Bulk import" };

/**
 * FR-15. A CSV of already-digitised records is still paper consent, so it goes
 * through the same door: one draft per row, reviewed, then commitDraft(). There
 * is no bulk write path into consent_artifact.
 */
export default async function ImportPage() {
  try {
    await requireStaff("dpo");
  } catch {
    redirect("/staff");
  }

  const [purposes, notices] = await Promise.all([loadPurposes(), loadNotices()]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Bulk import</h1>
        <p className="mt-1 text-sm text-muted">
          A spreadsheet of records already typed out of the filing cabinet. Every row still
          becomes a draft that a person confirms, and every row commits on its own — one bad
          row does not undo the others.
        </p>
      </div>
      <ImportClient
        purposes={purposes.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
        notices={notices.map((n) => ({ id: n.id, label: `${n.form_label} (v${n.version})` }))}
      />
    </div>
  );
}
