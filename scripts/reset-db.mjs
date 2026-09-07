/**
 * Drops the schema and rebuilds it empty. Development only.
 *
 * WHY THIS EXISTS, and why it is not `DELETE FROM`:
 *
 * Test residue cannot be deleted row by row, and that is correct rather than
 * unfortunate. `consent_artifact` is append-only by trigger, and
 * `consent_artifact.transcribed_by` references `staff_user` ON DELETE RESTRICT -
 * so a staff row that has transcribed an artifact can never be removed. That is
 * the evidence model working: a Board proceeding asks who transcribed a form,
 * and the answer must outlive anybody's tidying up.
 *
 * The consequence is that a developer's database accumulates. Specs that must
 * commit - the bulk importer's separate-transaction behaviour, the OTP
 * brute-force counter's behaviour across connections - cannot use the
 * transaction-rollback helper, because a single shared client serialises exactly
 * the concurrency they exist to test. They clean up what they can and document
 * what they cannot. CI starts fresh every run; a laptop does not.
 *
 * So the honest tool is not a smarter cleanup. It is this: throw the database
 * away and build it again.
 *
 * Refuses to run against anything that does not look local, because the whole
 * point of the invariants this drops is that they are not recoverable.
 */
import pg from "pg";

/**
 * Loopback only, and deliberately NOT the container service names.
 *
 * "postgres" and "db" were in this set and had to come out: they are DNS
 * service names, not local addresses. A production database reachable as
 * `postgres:5432` - the default Kubernetes Service name, and the name this
 * repo's own compose file gives the service - would have passed a guard whose
 * entire job is to refuse anything that is not a laptop, and then had
 * DROP SCHEMA public CASCADE run against an append-only evidence database.
 *
 * The entries were never needed either: compose maps 5433:5432 on the host, so
 * a developer's URL is localhost:5433. A guard that is wrong in the permissive
 * direction on a one-way door is worse than no guard, because it reads as one.
 *
 * "[::1]" is listed because `new URL(...).hostname` keeps the brackets on an
 * IPv6 literal, so the bare "::1" spelling never matches anything.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("DATABASE_URL is not a URL this script can read.");
    process.exit(1);
  }

  // NODE_ENV is not a host check and cannot replace one, but a production
  // process has no business dropping a schema under any hostname.
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to reset: NODE_ENV=production.");
    process.exit(1);
  }

  if (!LOCAL_HOSTS.has(host) && process.env.ALLOW_REMOTE_RESET !== "yes") {
    console.error(
      `Refusing to reset a database on "${host}".\n` +
        "This drops every consent artifact and audit entry, and both are append-only\n" +
        "precisely so that nothing can do that by accident. If you genuinely mean a\n" +
        "non-local host, set ALLOW_REMOTE_RESET=yes.",
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // CASCADE takes the append-only triggers with the tables they guard, so the
    // drop is not refused by the very rules that make row-level cleanup
    // impossible.
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    console.log(`Schema dropped and recreated on ${host}.`);
    console.log("Now run: npm run migrate && npm run seed");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
