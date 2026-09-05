<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# offline-consent

Read `README.md` before changing anything here — in particular the **Invariants**
section. This database holds legal evidence: several of those rules are enforced
by database triggers that will reject your write rather than warn you.

Two things worth knowing before you touch the data layer:

- `DATE` columns are parsed as `'YYYY-MM-DD'` strings, set in `src/lib/db.ts`.
  The default parser returns a `Date`, which shifts a paper date by timezone and
  makes every comparison against a date string silently false.
- Anything that mutates consent takes an `Executor`, so it can be composed into
  one transaction with its audit entry. Do not reach for the pool inside one.

Definition of done: `npm run lint && npm run typecheck && npm run build && npm test`
