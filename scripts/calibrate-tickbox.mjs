/**
 * Turns reviewed scans into a tuned INK_THRESHOLD.
 *
 * `ml/app/tickbox.py` ships INK_THRESHOLD = 0.08, a value that separates cleanly
 * on synthetic forms and has never seen real paper. Its own docstring says the
 * threshold should be set from real forms, and `ink_ratio` is returned on every
 * reading precisely so it can be.
 *
 * The ground truth already exists and nobody has ever read it. Every committed
 * draft carries two things on one row:
 *
 *   intake_draft.extraction  - what the service PROPOSED (ink_ratio per box)
 *   intake_draft.payload     - what a human CONFIRMED (granted per purpose)
 *
 * Joining those two is the calibration. This script does the join, reports what
 * the current threshold gets wrong, and proposes the value that separates real
 * ticks from real empty boxes on YOUR scans.
 *
 * Read-only. It never writes to the database and never edits tickbox.py; the
 * number it prints is for a human to move across, which is the same posture the
 * review screen takes toward extraction generally.
 *
 *   npm run calibrate
 */
import pg from "pg";

/**
 * Read from the running service, never restated here.
 *
 * These started as hand-copied constants, and that was a bug with a guaranteed
 * trigger: this script's own closing line tells the operator to set
 * INK_THRESHOLD in ml/app/tickbox.py and says nothing about the copy that lived
 * up here. So the first time the tool succeeded at its job, it became wrong -
 * and went on reporting misread counts "at the current threshold" for a
 * threshold that was no longer in force. Nothing would have errored.
 *
 * The fallbacks are only for a service that is not running, and say so in the
 * output when they are used.
 */
const ML = process.env.ML_SERVICE_URL ?? "http://localhost:8000";
const FALLBACK_THRESHOLD = 0.08;
const FALLBACK_MIN_ANCHOR = 0.62;

async function liveThresholds() {
  try {
    const health = await fetch(new URL("/health", ML)).then((r) => r.json());
    if (typeof health?.inkThreshold === "number") {
      return {
        threshold: health.inkThreshold,
        minAnchor: health.minAnchorScore ?? FALLBACK_MIN_ANCHOR,
        live: true,
      };
    }
  } catch {
    // Falls through to the fallbacks below.
  }
  return { threshold: FALLBACK_THRESHOLD, minAnchor: FALLBACK_MIN_ANCHOR, live: false };
}

const pct = (n, d) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`);
const f3 = (n) => (n === null || n === undefined ? "  n/a" : n.toFixed(3));

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * The threshold that misclassifies the fewest boxes.
 *
 * Ties are broken toward the LOWER candidate, which biases to calling a faint
 * mark ticked. That direction is deliberate: a box wrongly read as ticked is
 * visible to the reviewer beside the scan and gets corrected, whereas a real
 * tick read as empty looks exactly like a form where the person declined.
 */
function bestThreshold(ticked, empty) {
  const candidates = [...new Set([...ticked, ...empty])].sort((a, b) => a - b);
  if (candidates.length === 0) return null;

  let best = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const next = candidates[i + 1] ?? candidates[i] + 0.02;
    const t = (candidates[i] + next) / 2;
    const missedTicks = ticked.filter((v) => v < t).length;
    const falseTicks = empty.filter((v) => v >= t).length;
    const wrong = missedTicks + falseTicks;
    if (best === null || wrong < best.wrong) best = { t, wrong, missedTicks, falseTicks };
  }
  return best;
}

function score(ticked, empty, t) {
  const missed = ticked.filter((v) => v < t).length;
  const falsePos = empty.filter((v) => v >= t).length;
  return { missed, falsePos, wrong: missed + falsePos };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }
  const { threshold: CURRENT_THRESHOLD, minAnchor: MIN_ANCHOR_SCORE, live } =
    await liveThresholds();
  if (!live) {
    console.log(`\nCould not reach ${ML}; using built-in defaults`);
    console.log("(start it with: docker compose up -d ml)\n");
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT id, extraction, payload, evidence_id
         FROM intake_draft
        WHERE status = 'committed'
          AND extraction IS NOT NULL
        ORDER BY reviewed_at`,
    );

    if (rows.length === 0) {
      console.log("No committed drafts carry an extraction yet.\n");
      console.log("Nothing to calibrate from. Run some scans through");
      console.log("/staff/intake/new with ML_SERVICE_URL set, review and commit them,");
      console.log("then come back. Every scan reviewed with the service down is a");
      console.log("calibration point lost for good.");
      return;
    }

    const ticked = [];   // ink_ratio where the HUMAN said granted
    const empty = [];    // ink_ratio where the HUMAN said not granted
    let boxes = 0, anchorFailed = 0, lowAnchor = 0, noRatio = 0, agreed = 0, compared = 0;
    const perForm = [];

    for (const row of rows) {
      const readings = row.extraction?.tickboxes ?? [];
      const truth = new Map(
        (row.payload?.items ?? []).map((i) => [i.purposeId, Boolean(i.granted)]),
      );
      let formBoxes = 0, formAgreed = 0, formAnchorFail = 0;

      for (const r of readings) {
        boxes += 1;
        formBoxes += 1;

        if (r.granted === null) { anchorFailed += 1; formAnchorFail += 1; }
        if (r.anchorScore < MIN_ANCHOR_SCORE) lowAnchor += 1;

        const confirmed = truth.get(r.purposeId);
        if (confirmed === undefined) continue;

        if (r.granted !== null && r.granted === confirmed) { agreed += 1; formAgreed += 1; }
        if (r.granted !== null) compared += 1;

        if (r.inkRatio === null || r.inkRatio === undefined) { noRatio += 1; continue; }
        (confirmed ? ticked : empty).push(r.inkRatio);
      }

      perForm.push({
        id: row.id.slice(0, 8),
        engine: row.extraction?.engine ?? "?",
        boxes: formBoxes,
        agreed: formAgreed,
        anchorFail: formAnchorFail,
        hasScan: row.evidence_id !== null,
      });
    }

    console.log(`\nTICK-BOX CALIBRATION  ·  ${rows.length} committed scan(s), ${boxes} boxes\n`);

    console.log("Per form");
    console.log("  draft     engine      boxes  agreed  label-not-found  scan");
    for (const f of perForm) {
      console.log(
        `  ${f.id}  ${f.engine.padEnd(10)}  ${String(f.boxes).padStart(5)}  ` +
        `${String(f.agreed).padStart(6)}  ${String(f.anchorFail).padStart(15)}  ${f.hasScan ? "yes" : "no"}`,
      );
    }

    console.log("\nAnchoring  (can the printed wording be found at all?)");
    console.log(`  label not found          ${String(anchorFailed).padStart(4)} / ${boxes}  (${pct(anchorFailed, boxes)})`);
    console.log(`  anchor below ${MIN_ANCHOR_SCORE}        ${String(lowAnchor).padStart(4)} / ${boxes}  (${pct(lowAnchor, boxes)})`);
    if (anchorFailed > boxes * 0.2) {
      console.log("\n  >> More than a fifth of labels were not found. Before touching the");
      console.log("     threshold, check that consent_notice_purpose.printed_label matches");
      console.log("     the wording physically printed on the paper. Ink density cannot");
      console.log("     rescue a box the anchor never located.");
    }

    console.log("\nAgreement with the reviewer, at the CURRENT threshold");
    console.log(`  read and confirmed       ${String(agreed).padStart(4)} / ${compared}  (${pct(agreed, compared)})`);
    if (noRatio > 0) console.log(`  no ink_ratio recorded    ${String(noRatio).padStart(4)}`);

    const st = [...ticked].sort((a, b) => a - b);
    const se = [...empty].sort((a, b) => a - b);

    console.log("\nInk ratio by what the HUMAN confirmed");
    console.log(`  ticked  n=${String(st.length).padStart(3)}   min ${f3(st[0])}   p25 ${f3(quantile(st, .25))}   median ${f3(quantile(st, .5))}   max ${f3(st[st.length - 1])}`);
    console.log(`  empty   n=${String(se.length).padStart(3)}   min ${f3(se[0])}   p75 ${f3(quantile(se, .75))}   median ${f3(quantile(se, .5))}   max ${f3(se[se.length - 1])}`);

    if (st.length === 0 || se.length === 0) {
      console.log("\nCannot propose a threshold yet: need at least one confirmed TICKED box");
      console.log("and one confirmed EMPTY box. Scan a form with a mix of both.");
      return;
    }

    const now = score(st, se, CURRENT_THRESHOLD);
    const best = bestThreshold(st, se);
    const gap = se[se.length - 1] < st[0];

    console.log(`\nCurrent threshold ${CURRENT_THRESHOLD}`);
    console.log(`  misread  ${now.wrong} / ${st.length + se.length}   (${now.missed} real ticks missed, ${now.falsePos} empty boxes called ticked)`);

    console.log(`\nProposed threshold ${best.t.toFixed(3)}`);
    console.log(`  misread  ${best.wrong} / ${st.length + se.length}   (${best.missedTicks} real ticks missed, ${best.falseTicks} empty boxes called ticked)`);

    if (gap) {
      console.log(`\n  The two populations do not overlap: every empty box read below ${f3(se[se.length - 1])}`);
      console.log(`  and every tick above ${f3(st[0])}. Any threshold between them is correct on this`);
      console.log("  sample; the midpoint above leaves the most room on both sides.");
    } else {
      console.log("\n  The populations OVERLAP. Some empty boxes read darker than some real");
      console.log("  ticks, so no threshold separates them cleanly. That is a scan-quality");
      console.log("  signal, not a tuning problem: check for heavy borders, low DPI or");
      console.log("  faint pencil. Every reading stays a suggestion for a human either way.");
    }

    const n = st.length + se.length;
    if (n < 25) {
      console.log(`\n  CAUTION: ${n} boxes is a small sample. Treat this as a direction, not a`);
      console.log("  final value, and re-run as more forms are reviewed.");
    }

    console.log(`\nTo adopt: set INK_THRESHOLD = ${best.t.toFixed(2)} in ml/app/tickbox.py,`);
    console.log("rebuild the service (docker compose up -d --build ml), and re-run this.\n");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
