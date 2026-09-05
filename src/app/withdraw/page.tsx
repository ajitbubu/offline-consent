import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";
import { WithdrawClient } from "./withdraw-client";

export const metadata: Metadata = { title: "Find my consent record" };

export default function WithdrawPage() {
  return (
    <PublicShell>
      <WithdrawClient />
    </PublicShell>
  );
}
