import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { extractionConfigured } from "@/lib/extraction";
import { Callout } from "@/components/ui/callout";
import { DocumentsClient } from "@/components/documents-client";

export const metadata: Metadata = { title: "Scan documents" };

/**
 * Read a folder of documents and see what the extractor can get out of them.
 *
 * DELIBERATELY NOT THE REVIEW SCREEN. /staff/review takes one scan and walks a
 * person through committing it as consent, which is the right shape for a form
 * that becomes a legal record. It is the wrong shape for reading a hundred
 * documents to find out what the extractor manages, because the only way to keep
 * anything there is commitDraft() - one permanent, trigger-protected consent
 * record per document, for people who do not exist.
 *
 * So this screen scans and reports, and commits nothing. The route to consent
 * stays where it was.
 */
export default async function DocumentsPage() {
  try {
    await requireStaff();
  } catch {
    redirect("/staff");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Scan documents</h1>
        <p className="mt-1 text-sm text-muted">
          Attach a folder, read what comes back, export it. Nothing here becomes
          consent.
        </p>
      </div>

      {!extractionConfigured() && (
        <Callout tone="amber">
          <strong className="font-medium">Extraction is not configured.</strong>{" "}
          <code>ML_SERVICE_URL</code> is unset, so scanning will return nothing
          for every document. Start the service with{" "}
          <code>docker compose up -d ml</code> and point the variable at it.
        </Callout>
      )}

      <DocumentsClient />
    </div>
  );
}
