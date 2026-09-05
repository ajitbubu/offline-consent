/**
 * Forward-only migration runner.
 *
 * Migrations are applied in filename order, once, inside a transaction, and
 * recorded with a checksum. An already-applied file whose contents changed is a
 * hard error: editing applied SQL means two environments silently disagree
 * about their schema, and this database holds legal evidence.
 *
 * Plain JS on purpose - run with `node --env-file-if-exists=.env`, so there is
 * no tsx, ts-node or dotenv in the dependency tree.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const checksum = (sql) => createHash("sha256").update(sql).digest("hex");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map(
      (await client.query("SELECT filename, checksum FROM schema_migrations")).rows.map(
        (r) => [r.filename, r.checksum],
      ),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ran = 0;

    for (const filename of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
      const sum = checksum(sql);
      const previous = applied.get(filename);

      if (previous !== undefined) {
        if (previous !== sum) {
          throw new Error(
            `${filename} has already been applied but its contents have changed.\n` +
              `  applied: ${previous}\n  on disk: ${sum}\n` +
              `Migrations are forward-only. Add a new migration instead of editing this one.`,
          );
        }
        continue;
      }

      // Each migration is its own transaction, so a failure halfway through the
      // set leaves the earlier ones applied and this one fully rolled back.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, sum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`${filename} failed: ${error.message}`, { cause: error });
      }

      console.log(`applied ${filename}`);
      ran += 1;
    }

    console.log(
      ran === 0
        ? `up to date (${files.length} migration${files.length === 1 ? "" : "s"} already applied)`
        : `done, ${ran} migration${ran === 1 ? "" : "s"} applied`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
