/**
 * Is the Google Cloud path actually wired, and does it actually work?
 *
 * TWO DIFFERENT QUESTIONS, AND THE DIFFERENCE MATTERS. Configuration being
 * present proves nothing: every value here can be set correctly and the first
 * real scan can still fail on billing, on an API that was never enabled, or on
 * a processor that lives in another region. So this reports CONFIGURED and
 * VERIFIED separately, and only `--probe` can move something into VERIFIED,
 * because only `--probe` sends a page and reads what comes back.
 *
 * Nothing here sends a real person's document. The probe uses a generated blank
 * page, so running it costs one page of OCR and discloses nothing.
 *
 * WHY A SCRIPT RATHER THAN A README SECTION. A README goes stale silently and
 * you find out at the demo. This tells you which of the seven steps you are on
 * and the one command that advances it.
 *
 *   npm run check:gcp
 *   npm run check:gcp -- --probe      # sends one blank page, costs ~1 page
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const probe = process.argv.includes("--probe");

const OK = "  \x1b[32mOK\x1b[0m     ";
const MISS = "  \x1b[31mMISSING\x1b[0m";
const WARN = "  \x1b[33mCHECK\x1b[0m  ";

const results = [];
const record = (state, label, detail, fix) =>
  results.push({ state, label, detail, fix });

// 1. The CLI. Not strictly required if credentials arrive another way, but it
// is the only route to application-default credentials on a laptop.
let gcloud = null;
try {
  gcloud = execFileSync("gcloud", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\n")[0];
  record(OK, "gcloud CLI", gcloud, null);
} catch {
  record(MISS, "gcloud CLI", "not on PATH", "brew install --cask google-cloud-sdk");
}

// 2. Application Default Credentials. The SDKs look here; a service-account
// JSON path is the documented local-development alternative and nothing else.
const adcPath = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (existsSync(adcPath)) {
  record(OK, "credentials", "application default credentials present", null);
} else if (sa && existsSync(sa)) {
  record(WARN, "credentials", `service-account key at ${sa}`,
    "fine for local dev only; production uses Workload Identity, and this key must never be committed");
} else {
  record(MISS, "credentials", "no ADC and no GOOGLE_APPLICATION_CREDENTIALS",
    "gcloud auth application-default login");
}

// 3-4. Project and region. Region is not cosmetic: a processor is region-scoped,
// and for scans of Indian consent forms the region decides whether the document
// leaves the jurisdiction. asia-south1 is Mumbai.
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION;
record(project ? OK : MISS, "GOOGLE_CLOUD_PROJECT", project ?? "unset",
  project ? null : "add GOOGLE_CLOUD_PROJECT=<your-project-id> to .env");
record(location ? OK : MISS, "GOOGLE_CLOUD_LOCATION", location ?? "unset",
  location ? null : "add GOOGLE_CLOUD_LOCATION=asia-south1 to .env (Mumbai; keeps scans in India)");

// 5. Which engine, and therefore which extra config is needed. Cloud Vision
// needs no processor; Document AI does.
const ocrProcessor = process.env.DOCUMENT_AI_OCR_PROCESSOR_ID;
const ocrVersion = process.env.DOCUMENT_AI_OCR_PROCESSOR_VERSION;
record(ocrProcessor ? OK : MISS, "DOCUMENT_AI_OCR_PROCESSOR_ID", ocrProcessor ?? "unset",
  ocrProcessor ? null
    : "create an Enterprise Document OCR processor, then add its id. Cloud Vision needs no processor - use the 'vision' engine instead.");
record(ocrVersion ? OK : WARN, "DOCUMENT_AI_OCR_PROCESSOR_VERSION", ocrVersion ?? "unpinned",
  ocrVersion ? null
    : "unpinned means Google may move the model under a stored accuracy number. Pin it before measuring anything you intend to keep.");

// 6. Mock mode. The single switch that decides whether a scan leaves the host.
const mock = (process.env.DOCUMENT_AI_MOCK_MODE ?? "").toLowerCase();
const mockOn = ["1", "true", "yes"].includes(mock);
record(mockOn ? WARN : OK, "DOCUMENT_AI_MOCK_MODE", mockOn ? "ON - fixtures, no network" : "off - real calls",
  mockOn ? "unset it to make real calls; keep it ON for tests and local development" : null);

// 7. The engine the app will actually use. Config for an engine nothing selects
// is config that proves nothing.
const mlUrl = process.env.ML_SERVICE_URL;
record(mlUrl ? OK : WARN, "ML_SERVICE_URL", mlUrl ?? "unset",
  mlUrl ? null : "unset means the app skips extraction entirely and the review screen is manual entry");

console.log("\n  GOOGLE CLOUD PREFLIGHT\n");
for (const r of results) {
  console.log(`${r.state} ${r.label.padEnd(34)} ${r.detail}`);
  if (r.fix) console.log(`           -> ${r.fix}`);
}

const missing = results.filter((r) => r.state === MISS).length;

console.log("");
if (missing > 0) {
  console.log(`  ${missing} step(s) outstanding. CONFIGURED: no. VERIFIED: no.\n`);
  console.log("  The four that need your account, in order:");
  console.log("    1. gcloud auth login");
  console.log("    2. gcloud config set project <your-project-id>");
  console.log("    3. gcloud services enable documentai.googleapis.com vision.googleapis.com");
  console.log("    4. gcloud auth application-default login");
  console.log("");
  console.log("  Then for Document AI only, create a processor and copy its id.");
  console.log("  NOTE: gcloud has NO documentai command group - not in stable, alpha");
  console.log("  or beta. Use the REST API or the Console. Verified 2026-09-08.");
  console.log("");
  console.log("    TOKEN=$(gcloud auth print-access-token)");
  console.log("    curl -s -X POST -H \"Authorization: Bearer $TOKEN\" \\");
  console.log("      -H \"Content-Type: application/json\" \\");
  console.log("      https://asia-south1-documentai.googleapis.com/v1/projects/$GOOGLE_CLOUD_PROJECT/locations/asia-south1/processors \\");
  console.log("      -d '{\"type\":\"OCR_PROCESSOR\",\"displayName\":\"consent-ocr\"}'");
  console.log("");
  process.exit(1);
}

console.log("  CONFIGURED: yes.");
if (!probe) {
  console.log("  VERIFIED:   no - configuration alone proves nothing.");
  console.log("              Run `npm run check:gcp -- --probe` to send one blank page.\n");
  process.exit(0);
}

// The probe. Deliberately a generated blank page: it proves auth, billing, API
// enablement, region and processor id in one call, and discloses nothing.
console.log("\n  Probing with one generated blank page...\n");
try {
  const out = execFileSync(
    "uv",
    ["run", "python", "-c", `
import io, os
from PIL import Image
from app.engines import get_engine
name = "documentai" if os.environ.get("DOCUMENT_AI_OCR_PROCESSOR_ID") else "vision"
eng = get_engine(name)
print(f"  engine   : {name}")
print(f"  version  : {eng.version()}")
img = Image.new("L", (1200, 400), color=255)
tokens = eng.tokens(img)
print(f"  response : {len(tokens)} tokens from a blank page (0 is the correct answer)")
print("  VERIFIED : the call reached Google and came back")
`],
    { cwd: "ml", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(out);
} catch (error) {
  console.error("  PROBE FAILED. Configuration is present but the call did not work:\n");
  console.error((error.stderr || error.message).split("\n").slice(-12).join("\n"));
  console.error("\n  Common causes, in the order they usually bite:");
  console.error("    - billing not enabled on the project");
  console.error("    - documentai.googleapis.com / vision.googleapis.com not enabled");
  console.error("    - processor id belongs to a different region than GOOGLE_CLOUD_LOCATION");
  console.error("    - credentials belong to a different project\n");
  process.exit(1);
}
