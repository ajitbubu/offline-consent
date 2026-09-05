/**
 * PostgreSQL connection pool.
 *
 * Note on BIGINT: node-pg returns int8 columns (audit_log.id) as strings to
 * avoid silent precision loss past Number.MAX_SAFE_INTEGER. That default is
 * deliberately left in place - treat audit log ids as opaque strings and never
 * expose them in an API response.
 */
import "server-only";
import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env, isProduction } from "@/lib/env";

/**
 * DATE columns come back as plain 'YYYY-MM-DD' strings, not JS Date objects.
 *
 * Two things go wrong with the default parser, and both matter here:
 *
 *  - A Date carries a time and a zone. collected_on and consent_given_on are
 *    dates off a piece of paper, which has neither, so parsing 2019-03-04 into
 *    an instant makes it render as 3 March for anyone west of UTC. A consent
 *    date that shifts by a day is a wrong compliance record.
 *  - Relational comparison between a Date and a 'YYYY-MM-DD' string coerces the
 *    Date to epoch milliseconds and the string to NaN, so every such comparison
 *    is false. The "a later form supersedes an earlier one" rule in commitDraft
 *    is exactly that comparison, and it silently never fired.
 *
 * Strings compare correctly lexicographically in ISO order, which is what the
 * TypeScript types in intake.ts already assume.
 */
types.setTypeParser(types.builtins.DATE, (value) => value);

/**
 * Anything a query can run on: the pool, or a single client already inside a
 * transaction. Every function that writes takes one of these so a caller can
 * compose several of them into one atomic unit - a consent write and its audit
 * entry must commit together or not at all. Both Pool and PoolClient satisfy
 * this structurally.
 */
export interface Executor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

/**
 * Next dev reloads modules on every edit, which would leak a pool per reload
 * until Postgres refuses new connections. Stashing it on globalThis keeps one
 * pool across reloads.
 */
const globalForDb = globalThis as unknown as { __ocPool?: Pool };

export const pool: Pool =
  globalForDb.__ocPool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    ssl: env.DATABASE_URL.includes("sslmode=require")
      ? { rejectUnauthorized: isProduction }
      : false,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "offline-consent",
  });

if (!isProduction) globalForDb.__ocPool = pool;

// Errors on an idle client (network drop, server restart) surface here, not on
// a query. Without this listener Node treats it as an unhandled 'error' event
// and exits the process.
pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client", err.message);
});

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * Every consent mutation must write its table and audit_log atomically - a
 * consent change without its audit entry is a compliance gap - so the write
 * path always goes through here. Side effects that are not database writes
 * (notice delivery, downstream cessation) are enqueued only after this
 * resolves, never inside `fn`.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
