import "server-only";
import Link from "next/link";
import { env } from "@/lib/env";
import { latestFiduciaryContact } from "@/lib/catalogue";

/**
 * The chrome around every public page.
 *
 * The three public routes each declared their own <main> with a different
 * max-width and padding, and none of them carried a header, a footer, or the
 * name of the organisation holding the consent. So the landing page said
 * "Manage the consent you gave us on paper" with nothing anywhere on screen
 * saying who "us" was - and the staff console, used by trained operators, had
 * more orientation than the public page used by a stranger exercising a
 * statutory right.
 *
 * The footer is not decoration either: s.5(1)(iii) wants the Data Protection
 * Officer reachable, and before this the only page that named them was the
 * notice itself.
 */
export async function PublicShell({ children }: { children: React.ReactNode }) {
  const contact = await latestFiduciaryContact();

  return (
    <>
      <header className="border-b border-line bg-panel">
        <div className="mx-auto w-full max-w-2xl px-6">
          <Link
            href="/"
            className="inline-block py-4 text-sm font-semibold text-ink hover:text-blue"
          >
            {env.ORG_NAME}
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">{children}</main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-1 px-6 py-6 text-xs text-muted">
          <p>Consent register of {env.ORG_NAME}.</p>
          {contact && <p>Questions or complaints: {contact}</p>}
        </div>
      </footer>
    </>
  );
}
