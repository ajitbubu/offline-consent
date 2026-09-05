import type { Metadata } from "next";
import { LoginClient } from "./login-client";

export const metadata: Metadata = { title: "Sign in" };

export default function StaffLoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-ink">Consent register</h1>
        <p className="mt-1 text-sm text-muted">Staff sign in</p>
        <div className="mt-6 rounded-lg border border-line bg-panel p-6">
          <LoginClient />
        </div>
      </div>
    </main>
  );
}
