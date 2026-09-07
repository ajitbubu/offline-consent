/**
 * Renders a sample consent form whose printed wording matches a real notice
 * version in the database.
 *
 * WHY THIS EXISTS. Tick-box reading anchors on the wording printed beside each
 * box, fuzzy-matched against `consent_notice_purpose.printed_label`. If the two
 * disagree the anchor fails, `granted` comes back null, and no amount of
 * threshold tuning helps - the box was never located. That failure is silent
 * from the outside and looks like "OCR is bad".
 *
 * So before feeding real scans in, it is worth seeing the pipeline succeed on a
 * form that is known to match. This renders one, straight from the notice rows,
 * so the labels cannot drift from what the database expects.
 *
 * It is a TEST FIXTURE, not a form to give anybody. It carries invented details.
 *
 *   npm run sample:form                              # newest notice, boxes 1 and 3 ticked
 *   npm run sample:form -- --notice membership-form  # pick one explicitly
 *   npm run sample:form -- --ticked 1,2,5            # choose which boxes are ticked
 *   npm run sample:form -- --out /tmp/form.png
 *   npm run sample:form -- --list                    # show the notices available
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const run = promisify(execFile);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const OUT = arg("out", "/tmp/sample-form.png");
const TICKED = String(arg("ticked", "1,3"))
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const APPLICANT = {
  name: arg("name", "Priya Sharma"),
  mobile: arg("mobile", "98765 43210"),
  email: arg("email", "priya.sharma@example.org"),
  signed: arg("signed", "4 March 2019"),
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let notice, labels;
  try {
    // Named explicitly, or the newest published. "Newest" is a convenience and
    // NOT reliable on a developer database: specs that must commit leave
    // fixture notices behind called "Test Form", and one of those being the
    // most recent silently rendered a three-box test form instead of the real
    // one. Name the notice when it matters.
    const wanted = arg("notice", null);
    const { rows } = await client.query(
      wanted
        ? `SELECT id, code, version, form_label FROM consent_notice
            WHERE published_at IS NOT NULL AND code = $1
            ORDER BY version DESC LIMIT 1`
        : `SELECT id, code, version, form_label FROM consent_notice
            WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1`,
      wanted ? [wanted] : [],
    );

    if (process.argv.includes("--list") || rows.length === 0) {
      const { rows: all } = await client.query(
        `SELECT n.code, n.version, n.form_label, count(np.purpose_id) AS boxes
           FROM consent_notice n
           LEFT JOIN consent_notice_purpose np ON np.notice_id = n.id
          WHERE n.published_at IS NOT NULL
          GROUP BY n.id ORDER BY n.published_at DESC`,
      );
      if (rows.length === 0 && wanted) console.error(`\nNo published notice with code "${wanted}".`);
      else if (rows.length === 0) console.error("\nNo published notice at all. Run: npm run seed");
      console.error("\nPublished notices:");
      for (const n of all) {
        console.error(`  ${n.code} v${n.version}  ${n.boxes} boxes  ${n.form_label}`);
      }
      console.error("\nPick one with:  npm run sample:form -- --notice <code>\n");
      process.exit(rows.length === 0 ? 1 : 0);
    }
    notice = rows[0];
    const { rows: ls } = await client.query(
      `SELECT printed_label FROM consent_notice_purpose
        WHERE notice_id = $1 ORDER BY display_order`,
      [notice.id],
    );
    labels = ls.map((r) => r.printed_label);
  } finally {
    await client.end();
  }

  // Rendered in Python because Pillow is already a dependency of the ml
  // service and there is no image library on the Node side. Adding one to draw
  // a test fixture would be a dependency for nothing.
  const script = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

spec = json.loads(sys.argv[1])
CANDIDATES = ["/System/Library/Fonts/Supplemental/Arial.ttf",
              "/System/Library/Fonts/Helvetica.ttc",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
def font(size):
    for p in CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    raise SystemExit("no scalable font available")

W, H = 1700, 2400
img = Image.new("L", (W, H), 255)
d = ImageDraw.Draw(img)
d.text((140, 120), spec["title"].upper()[:46], font=font(44), fill=0)
d.line([140, 190, W - 140, 190], fill=0, width=3)

y = 250
for label, value in [("Full name:", spec["name"]), ("Mobile:", spec["mobile"]),
                     ("Email:", spec["email"])]:
    d.text((140, y), label, font=font(34), fill=0)
    d.text((470, y), value, font=font(34), fill=0)
    y += 76

y += 40
d.text((140, y), "I consent to the following:", font=font(34), fill=0)
y += 70

size, left = 44, 150
for i, text in enumerate(spec["labels"], start=1):
    d.rectangle([left, y, left + size, y + size], outline=0, width=3)
    if i in spec["ticked"]:
        d.line([left + 8, y + 8, left + size - 8, y + size - 8], fill=0, width=6)
        d.line([left + size - 8, y + 8, left + 8, y + size - 8], fill=0, width=6)
    # Wrapped so a long printed label stays on the page; the anchor matches on
    # the first line, which is how a real two-line label behaves too.
    words, line, lines = text.split(), "", []
    for w in words:
        trial = (line + " " + w).strip()
        if len(trial) > 58:
            lines.append(line); line = w
        else:
            line = trial
    lines.append(line)
    for n, ln in enumerate(lines):
        d.text((left + size + 30, y + 2 + n * 40), ln, font=font(31), fill=0)
    y += max(size + 40, len(lines) * 40 + 40)

y += 50
d.text((140, y), "Signed:", font=font(34), fill=0)
d.text((470, y), spec["signed"], font=font(34), fill=0)
d.text((140, y + 90), "Signature:", font=font(34), fill=0)
d.line([470, y + 130, 1000, y + 130], fill=0, width=2)

img.save(spec["out"])
print(spec["out"])
`;

  const spec = {
    title: notice.form_label,
    name: APPLICANT.name,
    mobile: APPLICANT.mobile,
    email: APPLICANT.email,
    signed: APPLICANT.signed,
    labels,
    ticked: TICKED,
    out: OUT,
  };

  try {
    await run("uv", ["run", "python", "-c", script, JSON.stringify(spec)], { cwd: "ml" });
  } catch (error) {
    console.error("Could not render. Is `uv` installed and `ml` set up?");
    console.error(error.stderr || error.message);
    process.exit(1);
  }

  console.log(`\nRendered ${OUT}`);
  console.log(`Notice:  ${notice.code} v${notice.version} — ${notice.form_label}`);
  console.log(`Ticked:  ${TICKED.join(", ") || "none"} of ${labels.length}`);
  console.log(`Person:  ${APPLICANT.name} · ${APPLICANT.mobile} · ${APPLICANT.email}\n`);
  console.log("The printed wording comes from the notice rows, so the tick-box");
  console.log("anchor is guaranteed to match. A real form that does NOT match its");
  console.log("notice is the usual reason boxes come back null.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
