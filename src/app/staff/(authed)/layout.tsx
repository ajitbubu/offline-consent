import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { StaffNav } from "@/components/staff-nav";

/**
 * The single authentication gate for every staff screen. /staff/login sits
 * outside this route group deliberately, so there is exactly one place where
 * staff access is decided rather than a check repeated per page.
 */
export default async function AuthedStaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let staff;
  try {
    staff = await requireStaff();
  } catch {
    redirect("/staff/login");
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <StaffNav role={staff.role} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
