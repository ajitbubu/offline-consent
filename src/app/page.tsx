import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PublicShell } from "@/components/public-shell";

export default function HomePage() {
  return (
    <PublicShell>
      <h1 className="text-xl font-semibold text-ink">
        Manage the consent you gave us on paper
      </h1>
      <p className="mt-3 text-ink">
        If you signed a form with us, you can see what you agreed to and withdraw your
        consent at any time. Withdrawing is as easy as giving — you do not need an
        account or a password.
      </p>

      <Link
        href="/withdraw"
        className="mt-8 inline-flex w-fit items-center gap-2 rounded-md bg-navy px-5 py-3 text-sm font-medium text-white hover:bg-ink"
      >
        Find my consent record
        <ArrowRight size={16} aria-hidden />
      </Link>

      <p className="mt-10 text-sm text-muted">
        Staff of the organisation should{" "}
        <Link href="/staff/login" className="text-blue hover:underline">
          sign in here
        </Link>
        .
      </p>
    </PublicShell>
  );
}
