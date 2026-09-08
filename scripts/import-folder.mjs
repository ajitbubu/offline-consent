/**
 * A folder of scans becomes a labelling dataset. Nothing becomes consent.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE. Until now the only way to persist a
 * correction was `commitDraft()`, and that writes a `consent_artifact` row -
 * a table carrying no_update, no_delete and no_truncate triggers. Labelling a
 * hundred and fifty test forms therefore meant a hundred and fifty permanent,
 * undeletable consent records for people who do not exist, inside a register
 * that holds legal evidence. There was no way to say "I am only studying this
 * document".
 *
 * `dataset_document` (migration 017) is that concept, and this is the door into
 * it. Rows land with origin='synthetic'. NOTHING here touches consent_artifact,
 * consent_record, or intake_draft, and this script has no code path that could.
 *
 * WHY IT REUSES evidence_object RATHER THAN A SECOND STORE. The bytes need a
 * hash for de-duplication, a retention date, and an access-logged download
 * route. All three already exist and are already audited. A parallel store for
 * "training files" would be a second place personal data can hide from the
 * retention sweep, which is exactly the failure a compliance product cannot
 * afford.
 *
 * IDEMPOTENT, BY HASH. Re-running over the same folder imports nothing twice:
 * identical bytes are the same file (evidence_object_sha256_idx has existed
 * since migration 004 for precisely this), and (evidence_id, dataset_version)
 * is unique on dataset_document.
 *
 *   npm run import:folder -- docs/training-data/hand-written
 *   npm run import:folder -- docs/training-data --split test --version v1
 *   npm run import:folder -- docs/training-data --dry-run
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

// Mirrors sniffContentType in src/lib/evidence.ts. Restated rather than
// imported because these scripts are plain .mjs and the library is TypeScript -
// the same split extract-batch.mjs and calibrate-tickbox.mjs already live with.
// If the magic numbers there change, change them here: src/lib/evidence.ts is
// the source of truth, this is the copy.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffContentType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  // Deliberately no CSV: a spreadsheet is not a scan, and accepting one here
  // would put a file with no pages into a dataset meant for page images.
  return null;
}

// Matches MAX_EVIDENCE_BYTES in src/lib/evidence.ts and MAX_BYTES in the ml
// service. A file the extractor will refuse is not worth storing.
const MAX_BYTES = 15 * 1024 * 1024;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && !entry.name.startsWith(".")) yield full;
  }
}

async function countConsent(client) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM consent_artifact)      AS artifacts,
            (SELECT count(*) FROM consent_record)        AS records,
            (SELECT count(*) FROM consent_artifact_item) AS items`,
  );
  return {
    artifacts: Number(rows[0].artifacts),
    records: Number(rows[0].records),
    items: Number(rows[0].items),
  };
}


async function main() {
  const target = process.argv[2];
  if (!target || target.startsWith("--")) {
    console.error("usage: npm run import:folder -- <directory> [--split train|validation|test] [--version v1] [--dry-run]");
    process.exit(1);
  }

  const split = arg("--split", "train");
  if (!["train", "validation", "test"].includes(split)) {
    console.error(`--split must be train, validation or test (got ${split})`);
    process.exit(1);
  }
  const datasetVersion = arg("--version", "v1");
  const dryRun = process.argv.includes("--dry-run");

  const dir = resolve(process.cwd(), target);
  const evidenceRoot = resolve(process.cwd(), process.env.EVIDENCE_DIR ?? "./.evidence");

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  // Attribution is required on evidence_object and it must be a real staff row.
  // Whoever runs the import owns the files it creates; there is no "system"
  // user, on purpose - every stored document names a person.
  const { rows: staff } = await client.query(
    "SELECT id, email FROM staff_user ORDER BY created_at LIMIT 1",
  );
  if (staff.length === 0) {
    console.error("No staff_user rows. Run `npm run seed` first - stored evidence must name an uploader.");
    process.exit(1);
  }
  const uploader = staff[0];

  // The invariant this script exists to hold, measured rather than promised.
  // A comment saying "this never writes consent" is worth nothing the day
  // someone adds a helper that does; a count taken before and after is worth
  // something on every run.
  const consentBefore = await countConsent(client);

  let seen = 0, skippedType = 0, skippedSize = 0, reusedBytes = 0, imported = 0, already = 0;

  for await (const path of walk(dir)) {
    seen += 1;
    const bytes = await readFile(path);
    const contentType = sniffContentType(bytes);
    if (!contentType) { skippedType += 1; continue; }
    if (bytes.length === 0 || bytes.length > MAX_BYTES) { skippedSize += 1; continue; }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = path.slice(dir.length + 1);

    if (dryRun) {
      console.log(`  would import  ${filename}  (${contentType}, ${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);
      imported += 1;
      continue;
    }

    try {
      await client.query("BEGIN");

      // Same bytes, same file. A second copy would be a second retention record
      // for one document, which is how personal data survives a purge.
      const { rows: existing } = await client.query(
        "SELECT id FROM evidence_object WHERE sha256 = $1 AND deleted_at IS NULL LIMIT 1",
        [sha256],
      );

      let evidenceId;
      if (existing.length > 0) {
        evidenceId = existing[0].id;
        reusedBytes += 1;
      } else {
        const now = new Date();
        const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
        const abs = join(evidenceRoot, storageKey);
        await mkdir(join(abs, ".."), { recursive: true });
        await writeFile(abs, bytes);

        const { rows } = await client.query(
          `INSERT INTO evidence_object
             (storage_key, kind, content_type, original_filename, byte_size,
              sha256, retention_until, uploaded_by)
           VALUES ($1, 'scan', $2, $3, $4, $5, now() + interval '10 years', $6)
           RETURNING id`,
          [storageKey, contentType, filename, bytes.length, sha256, uploader.id],
        );
        evidenceId = rows[0].id;
      }

      // origin='synthetic' is the load-bearing value. A real person's form needs
      // origin='authorised_production' plus a named, dated authoriser, which the
      // table's CHECK constraint enforces and this script deliberately cannot set.
      const { rowCount } = await client.query(
        `INSERT INTO dataset_document
           (evidence_id, origin, split, dataset_version)
         VALUES ($1, 'synthetic', $2, $3)
         ON CONFLICT (evidence_id, dataset_version) DO NOTHING`,
        [evidenceId, split, datasetVersion],
      );

      await client.query("COMMIT");
      if (rowCount === 1) imported += 1; else already += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`  FAILED  ${filename}: ${error.message}`);
    }
  }

  const consentAfter = await countConsent(client);
  client.release();
  await pool.end();

  console.log(`\n  ${seen} files under ${target}`);
  console.log(`    imported to dataset '${datasetVersion}' / ${split} : ${imported}`);
  if (already) console.log(`    already in this dataset version        : ${already}`);
  if (reusedBytes) console.log(`    bytes already stored, evidence reused  : ${reusedBytes}`);
  if (skippedType) console.log(`    not a scan (jpeg/png/pdf only)         : ${skippedType}`);
  if (skippedSize) console.log(`    empty or over 15MB                     : ${skippedSize}`);
  if (!dryRun) {
    const leaked =
      consentAfter.artifacts !== consentBefore.artifacts ||
      consentAfter.records !== consentBefore.records ||
      consentAfter.items !== consentBefore.items;
    if (leaked) {
      console.error(
        `\n  INVARIANT BROKEN: consent rows changed during import.\n` +
        `    artifacts ${consentBefore.artifacts} -> ${consentAfter.artifacts}\n` +
        `    records   ${consentBefore.records} -> ${consentAfter.records}\n` +
        `    items     ${consentBefore.items} -> ${consentAfter.items}\n` +
        `  These tables are append-only by trigger, so this cannot be undone.`,
      );
      process.exit(1);
    }
    console.log(
      `\n  Consent untouched, verified: artifacts ${consentAfter.artifacts}, ` +
      `records ${consentAfter.records}, items ${consentAfter.items} (unchanged).`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
