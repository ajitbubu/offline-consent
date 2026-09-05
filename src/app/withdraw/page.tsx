import type { Metadata } from "next";
import { WithdrawClient } from "./withdraw-client";

export const metadata: Metadata = { title: "Find my consent record" };

export default function WithdrawPage() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-6 py-12">
      <WithdrawClient />
    </main>
  );
}
