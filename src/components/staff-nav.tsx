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
      {/*
        The nav has no breakpoint of its own, so wordmark + four icon links +
        role + sign-out pushed the document to 675px wide inside a 375px
        viewport and the whole console scrolled sideways on a phone.
        overflow-x-auto contains it, shrink-0 stops the wordmark collapsing, and
        the link labels drop below sm so the icons still identify each one.
      */}
      <div className="mx-auto flex w-full max-w-6xl items-center gap-4 overflow-x-auto px-6 sm:gap-6">
        <span className="shrink-0 py-4 text-sm font-semibold text-ink">Consent register</span>
        <nav aria-label="Staff sections" className="flex flex-1 items-center gap-1">
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
                className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-4 text-sm ${
                  active
                    ? "border-navy font-medium text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                <Icon size={15} aria-hidden />
                <span className="hidden sm:inline">{link.label}</span>
                <span className="sr-only sm:hidden">{link.label}</span>
              </Link>
            );
          })}
        </nav>
        <span className="hidden shrink-0 text-xs text-muted sm:inline">
          {staffRoleLabels[role]}
        </span>
        <button
          onClick={signOut}
          className="flex shrink-0 items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <LogOut size={15} aria-hidden />
          Sign out
        </button>
      </div>
    </header>
  );
}
