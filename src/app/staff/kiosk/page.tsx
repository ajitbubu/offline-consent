import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { loadNotices } from "@/lib/catalogue";
import { KioskClient } from "@/components/kiosk-client";

export const metadata: Metadata = { title: "Counter kiosk" };

/**
 * FR-16.
 *
 * Deliberately OUTSIDE the (authed) route group, which renders the staff
 * navigation on every page it wraps. The person holding this tablet is a member
 * of the public standing at a counter, and one tap on "Register" would put the
 * whole consent register in their hands. It carries its own auth gate instead,
 * the same way /staff/login sits outside the group.
 */
export default async function KioskPage() {
  try {
    await requireStaff();
  } catch {
    redirect("/staff/login");
  }

  const notices = await loadNotices();
  if (notices.length === 0) {
    return (
      <main className="mx-auto w-full max-w-lg flex-1 px-6 py-12">
        <h1 className="text-xl font-semibold text-ink">Counter kiosk</h1>
        <p className="mt-2 text-sm text-muted">
          No published form version, so there are no tick-boxes to show. Publish a notice
          first.
        </p>
        <Link href="/staff" className="mt-4 inline-block text-sm text-blue hover:underline">
          Back to the console
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
      <KioskClient
        notices={notices.map((n) => ({
          id: n.id,
          label: `${n.form_label} (v${n.version})`,
          purposes: n.purposes,
        }))}
      />
    </main>
  );
}
