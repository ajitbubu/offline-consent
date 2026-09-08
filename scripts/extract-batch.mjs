/**
 * Headless extraction over documents already stored in the database.
 *
 * Reads `evidence_object` rows, pulls the bytes off disk, runs them through the
 * extraction service, and writes what came back into an `intake_draft`:
 *
 *   ocr_tokens  - every word with its box, the training pair for the layout model
 *   extraction  - what the service PROPOSED: fields and tick-box readings
 *   payload     - pre-filled from the high-confidence fields, for a human to check
 *
 * WHY IT STOPS AT A DRAFT, AND DOES NOT COMMIT.
 *
 * `commitDraft()` in src/lib/intake.ts is the only thing in this codebase that
 * writes a consent artifact, and it runs from the review screen after a person
 * has looked at the scan. That is not ceremony. A consent artifact is the
 * evidence that someone agreed to something, and OCR at 0.27 confidence
 * misreading an email address (which it does - see the doubled letter in
 * `priya.ssharma@example.org`) would become a recorded fact about a real person
 * that the database then refuses to let anyone edit, because the table is
 * append-only by trigger.
 *
 * So this script industrialises everything up TO the human, and nothing past it.
 * The extracted fields land in the database, queryable, exactly as asked - they
 * are simply not yet consent. Turning that last step on is a product decision
 * with statutory consequences, not a flag.
 *
 *   npm run extract:batch            # every scan with no draft yet
 *   npm run extract:batch -- --all   # re-extract, including scans already done
 *   npm run extract:batch -- --dry   # report only, write nothing
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

const ML = process.env.ML_SERVICE_URL ?? "http://localhost:8000";
const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "./.evidence";

/**
 * Below this a value is recorded but NOT pre-filled into payload.
 * Matches PREFILL_MIN_CONFIDENCE in src/lib/consent.ts: a wrong pre-fill is
 * worse than an empty field, because reviewers stop checking things that are
 * usually right.
 */
const PREFILL_MIN_CONFIDENCE = 0.7;

/**
 * Kept in step with EXTRACTION_SCHEMA_VERSION in src/lib/consent.ts.
 * This one stamps the STORED blob, so a stale copy here does not misbehave -
 * it mislabels rows in the column that is both the evidence and the training
 * corpus, and a mislabelled row cannot be re-derived later.
 */
const EXTRACTION_SCHEMA_VERSION = 2;

/** Kept in step with FIELD_REQUESTS in src/lib/extraction.ts. */
const FIELD_REQUESTS = [
  { key: "fullName", kind: "text", labels: ["Sole/First Holder Name", "Name of Applicant", "Name of Primary Depositor", "Applicant Name", "Name of the Enterprise/ Individual", "First Name", "Full name", "Name (Same as ID Proof)", "Member name", "Name"] },
  { key: "phone", kind: "phone", labels: ["Mobile No", "Mobile Number", "Mobile", "Telephone No", "Telephone Number", "Phone No", "Phone", "Telephone", "Contact number", "Tel"] },
  { key: "email", kind: "email", labels: ["Email ID", "E-mail ID", "Email address", "Email", "E-mail"] },
  { key: "collectedOn", kind: "date", labels: ["Date (DD/MM/YYYY)", "Date signed", "Signed", "Dated", "Date"] },
];

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const ALL = args.has("--all");

const trunc = (s, n) => (s === null || s === undefined ? "—" : String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

/** ISO date if the scanned text parses to one, else null. Never guesses. */
function parseDate(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\w\s\-/.]/g, " ").replace(/\s+/g, " ").trim();
  const parsed = Date.parse(cleaned);
  if (Number.isNaN(parsed)) return null;
  const d = new Date(parsed);
  // A date in the future is a misread, not a paper date.
  if (d.getTime() > Date.now()) return null;
  return d.toISOString().slice(0, 10);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const health = await fetch(new URL("/health", ML)).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`Extraction service is not answering on ${ML}.`);
    console.error("Start it with: docker compose up -d ml");
    process.exit(1);
  }
  console.log(`\nEngine: ${health.default} ${health.engineVersion}   ·   ${ML}\n`);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows: scans } = await client.query(
      `SELECT e.id, e.storage_key, e.content_type, e.original_filename, e.uploaded_by
         FROM evidence_object e
        WHERE e.deleted_at IS NULL
          ${ALL ? "" : "AND NOT EXISTS (SELECT 1 FROM intake_draft d WHERE d.evidence_id = e.id)"}
        ORDER BY e.uploaded_at`,
    );

    if (scans.length === 0) {
      console.log(ALL ? "No scans stored yet." : "No scans without a draft. Use --all to re-extract.");
      console.log("Upload one at /staff/intake/new, or insert into evidence_object directly.\n");
      return;
    }

    // The notice supplies the printed tick-box wording to anchor on. Newest
    // published version wins; a form that is not this version still gets its
    // fields read, because a name does not depend on knowing the notice.
    const { rows: notices } = await client.query(
      `SELECT id, code, version FROM consent_notice
        WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1`,
    );
    const notice = notices[0] ?? null;
    let labels = [];
    if (notice) {
      const { rows } = await client.query(
        `SELECT purpose_id, printed_label FROM consent_notice_purpose
          WHERE notice_id = $1 ORDER BY display_order, purpose_id`,
        [notice.id],
      );
      labels = rows.map((r) => ({ purposeId: r.purpose_id, text: r.printed_label }));
      console.log(`Notice: ${notice.code} v${notice.version}, ${labels.length} tick-boxes\n`);
    } else {
      console.log("No published notice, so tick-boxes will not be read. Fields still will.\n");
    }

    const base = resolve(process.cwd(), EVIDENCE_DIR);
    let written = 0, failed = 0;

    for (const scan of scans) {
      const name = trunc(scan.original_filename, 28);
      let bytes;
      try {
        bytes = await readFile(join(base, scan.storage_key));
      } catch {
        console.log(`  ${name.padEnd(28)}  BYTES MISSING at ${scan.storage_key}`);
        failed += 1;
        continue;
      }

      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(bytes)], { type: scan.content_type }), "scan");
      form.set("content_type", scan.content_type);
      form.set("labels", JSON.stringify(labels.map((l, index) => ({ index, text: l.text }))));
      form.set("fields", JSON.stringify(FIELD_REQUESTS));

      let body;
      try {
        const response = await fetch(new URL("/extract", ML), { method: "POST", body: form });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        body = await response.json();
      } catch (error) {
        console.log(`  ${name.padEnd(28)}  EXTRACT FAILED  ${error.message}`);
        failed += 1;
        continue;
      }

      const byKey = new Map((body.fields ?? []).map((f) => [f.key, f]));
      const get = (k) => byKey.get(k) ?? { value: null, confidence: 0, method: null };
      const fullName = get("fullName"), phone = get("phone"), email = get("email"), dated = get("collectedOn");

      console.log(`  ${name.padEnd(28)}  ${trunc(fullName.value, 22).padEnd(22)} ${trunc(phone.value, 14).padEnd(14)} ${trunc(email.value, 26).padEnd(26)} ${trunc(dated.value, 14)}`);
      console.log(`  ${"".padEnd(28)}  conf ${fullName.confidence.toFixed(2)}${" ".repeat(18)}${phone.confidence.toFixed(2)}${" ".repeat(10)}${email.confidence.toFixed(2)}${" ".repeat(22)}${dated.confidence.toFixed(2)}`);

      if (DRY) continue;

      // Only high-confidence values are pre-filled. Everything read is kept in
      // `extraction` regardless, so a reviewer can see what was proposed and
      // rejected - and so the corpus is complete either way.
      const ok = (f) => (f.value !== null && f.confidence >= PREFILL_MIN_CONFIDENCE ? f.value : null);
      const collectedOn = parseDate(ok(dated));

      const payload = {
        principal: {
          fullName: ok(fullName) ?? "",
          phone: ok(phone),
          phoneE164: null,
          email: ok(email),
        },
        noticeId: notice?.id ?? null,
        noticeAtCollection: "unknown",
        collectedOn,
        collectedOnPrecision: collectedOn ? "day" : "unknown",
        collectionLocation: null,
        subjectDeclaration: null,
        items: labels.map((l, index) => {
          const reading = (body.tickboxes ?? []).find((t) => t.index === index);
          return {
            purposeId: l.purposeId,
            // A reading we could not make is NOT a refusal. Absence of consent
            // is not consent, so an unread box defaults to false and the
            // reviewer has to look at the paper.
            granted: reading?.granted === true,
            verbatimLabel: l.text,
          };
        }),
      };

      const ocrTokens = {
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        engine: body.engine,
        engineVersion: body.engine_version,
        capturedAt: new Date().toISOString(),
        pages: body.pages,
      };

      const extraction = {
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        engine: body.engine,
        engineVersion: body.engine_version,
        extractedAt: new Date().toISOString(),
        fields: (body.fields ?? []).map((f) => ({
          key: f.key, value: f.value, confidence: f.confidence,
          anchorScore: f.anchor_score, method: f.method, page: f.page, bbox: f.bbox,
        })),
        tickboxes: (body.tickboxes ?? []).flatMap((t) => {
          const label = labels[t.index];
          if (!label) return [];
          return [{
            purposeId: label.purposeId, granted: t.granted, confidence: t.confidence,
            anchorScore: t.anchor_score, inkRatio: t.ink_ratio, page: t.page, bbox: t.bbox,
          }];
        }),
      };

      await client.query(
        `INSERT INTO intake_draft
           (source, status, evidence_id, payload, ocr_tokens, extraction, created_by)
         VALUES ('scan', 'needs_review', $1, $2, $3, $4, $5)`,
        [scan.id, JSON.stringify(payload), JSON.stringify(ocrTokens),
         JSON.stringify(extraction), scan.uploaded_by],
      );
      written += 1;
    }

    console.log(`\n${DRY ? "Would write" : "Wrote"} ${DRY ? scans.length - failed : written} draft(s); ${failed} failed.`);
    if (!DRY && written > 0) {
      console.log("\nThey are in `needs_review`. Query them:");
      console.log("  SELECT payload->'principal'->>'fullName', payload->'principal'->>'phone',");
      console.log("         payload->'principal'->>'email', payload->>'collectedOn'");
      console.log("    FROM intake_draft WHERE status = 'needs_review';");
      console.log("\nNothing is consent until a person commits it at /staff/review.\n");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
