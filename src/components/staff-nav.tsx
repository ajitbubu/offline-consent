"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BellRing, CopyCheck, FileText, FolderSearch, Inbox, LayoutDashboard, LifeBuoy, LogOut, OctagonX, Users } from "lucide-react";
import { roleAtLeast, staffRoleLabels, type StaffRole } from "@/lib/consent";

/**
 * What earns a slot in the primary nav is being somewhere people go daily.
 *
 * Bulk import and the counter kiosk are neither: one is an occasional job and
 * the other is a mode you put a tablet into once. They were pushing this row to
 * 1325px inside a 1152px container on a 1280px desktop, which quietly shoved
 * "Stop processing" - the s.6(6) queue - off the right-hand edge with no
 * affordance that anything was there. They live on the dashboard instead.
 *
 * `group` separates doing the work from working the compliance queues. They are
 * different jobs, usually for different people, and the role gate already knows
 * it.
 */
const LINKS = [
  { href: "/staff", label: "Overview", icon: LayoutDashboard, minimum: "operator", group: "work" },
  { href: "/staff/intake/new", label: "New form", icon: FileText, minimum: "operator", group: "work" },
  { href: "/staff/review", label: "Review", icon: Inbox, minimum: "operator", group: "work" },
  // Reads documents and commits nothing, so it sits with the work an operator
  // does rather than behind the DPO wall.
  { href: "/staff/documents", label: "Scan documents", icon: FolderSearch, minimum: "operator", group: "work" },
  { href: "/staff/principals", label: "Register", icon: Users, minimum: "dpo", group: "dpo" },
  { href: "/staff/duplicates", label: "Duplicates", icon: CopyCheck, minimum: "dpo", group: "dpo" },
  { href: "/staff/notices", label: "Notices", icon: BellRing, minimum: "dpo", group: "dpo" },
  { href: "/staff/cessation", label: "Stop processing", icon: OctagonX, minimum: "dpo", group: "dpo" },
  { href: "/staff/lookup-requests", label: "Help requests", icon: LifeBuoy, minimum: "dpo", group: "dpo" },
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
        The nav gets its OWN ROW. It did not, and could not fit.

        Sharing one row with the wordmark, the role label and Sign out left the
        links 714px inside a 1152px container, while eight links measure 890px.
        The scroller hid the difference rather than reporting it: "Stop
        processing" was clipped mid-word and "Help requests" sat entirely past
        the right edge, on a 1440px desktop with 260px of unused row above it.
        A horizontal scroller with no affordance is not a way to reach a link,
        it is a way to not know the link exists - and both of the ones being
        hidden were compliance queues with people waiting in them.

        Two rows costs about 45px of header and gives the links the full
        container width at every size. It also keeps what the previous fix was
        protecting: the wordmark stays left, Sign out stays right and reachable,
        and the NAV is still the only thing that scrolls, so a phone never
        drags the whole console sideways.

        min-w-0 stays: a flex child defaults to min-width:auto and refuses to
        shrink below its content, which is what pushed the root scroll width out
        even though every box measured the right size.

        Labels drop below sm so the icons still identify each link; the
        accessible name comes from aria-label rather than a hidden span.
      */}
      <div className="mx-auto w-full max-w-6xl px-6">
        <div className="flex items-center gap-4 pt-4 sm:gap-6">
          <span className="shrink-0 text-sm font-semibold text-ink">Consent register</span>
          <span className="ml-auto hidden shrink-0 text-xs text-muted sm:inline">
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
        <nav
          aria-label="Staff sections"
          className="flex min-w-0 w-full items-center overflow-x-auto"
        >
          {LINKS.filter((l) => roleAtLeast(role, l.minimum)).map((link, i, shown) => {
            const startsGroup = i > 0 && shown[i - 1].group !== link.group;
            const active =
              link.href === "/staff"
                ? pathname === "/staff"
                : pathname.startsWith(link.href);
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                // A hairline where the job changes: making the register work
                // versus working the compliance queues off the back of it.
                style={startsGroup ? { marginLeft: "0.75rem", borderLeftWidth: 0 } : undefined}
                href={link.href}
                aria-current={active ? "page" : undefined}
                // The visible label is display:none below sm, so the link needs
                // its name from somewhere. An sr-only span was the obvious
                // answer and the wrong one: sr-only is position:absolute, and an
                // absolutely positioned descendant escapes an overflow
                // container's clipping unless that container is itself
                // positioned - so the hidden labels sat past the right edge and
                // stretched the document by sixty pixels of scrollable nothing.
                aria-label={link.label}
                className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-4 text-sm ${
                  active
                    ? "border-navy font-medium text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                <Icon size={15} aria-hidden />
                <span className="hidden sm:inline">{link.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
