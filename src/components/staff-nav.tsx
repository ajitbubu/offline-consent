"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FileText, Inbox, LayoutDashboard, LogOut, Users } from "lucide-react";
import { roleAtLeast, staffRoleLabels, type StaffRole } from "@/lib/consent";

const LINKS = [
  { href: "/staff", label: "Overview", icon: LayoutDashboard, minimum: "operator" },
  { href: "/staff/intake/new", label: "New form", icon: FileText, minimum: "operator" },
  { href: "/staff/review", label: "Review queue", icon: Inbox, minimum: "operator" },
  { href: "/staff/principals", label: "Register", icon: Users, minimum: "dpo" },
] as const;

export function StaffNav({ role }: { role: StaffRole }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await fetch("/api/staff/auth/logout", {
      method: "POST",
      headers: { origin: window.location.origin },
    });
    router.replace("/staff/login");
    router.refresh();
  }

  return (
    <header className="border-b border-line bg-panel">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-6">
        <span className="py-4 text-sm font-semibold text-ink">Consent register</span>
        <nav className="flex flex-1 items-center gap-1">
          {LINKS.filter((l) => roleAtLeast(role, l.minimum)).map((link) => {
            const active =
              link.href === "/staff"
                ? pathname === "/staff"
                : pathname.startsWith(link.href);
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 border-b-2 px-3 py-4 text-sm ${
                  active
                    ? "border-navy font-medium text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                <Icon size={15} aria-hidden />
                {link.label}
              </Link>
            );
          })}
        </nav>
        <span className="text-xs text-muted">{staffRoleLabels[role]}</span>
        <button
          onClick={signOut}
          className="flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <LogOut size={15} aria-hidden />
          Sign out
        </button>
      </div>
    </header>
  );
}
