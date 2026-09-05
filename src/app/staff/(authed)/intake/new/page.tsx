import type { Metadata } from "next";
import { DraftForm } from "@/components/draft-form";
import { loadNotices, loadPurposes } from "@/lib/catalogue";
import { emptyPayload } from "@/lib/intake";

export const metadata: Metadata = { title: "Digitise a form" };

export default async function NewIntakePage() {
  const [purposes, notices] = await Promise.all([loadPurposes(), loadNotices()]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Digitise a paper form</h1>
        <p className="mt-1 text-sm text-muted">
          Attach the scan and record what it says. Nothing enters the register until you
          commit it.
        </p>
      </div>
      <DraftForm purposes={purposes} notices={notices} initialPayload={emptyPayload()} />
    </div>
  );
}
