# TODOS

Deferred work, with enough context to pick up cold.

> **State as of 6 September 2026.** Phases 0-7 are shipped and FR-1 to FR-16 are
> built; `lint && typecheck && build && test` is green at 163 tests, plus 18 in
> `ml`. What is left is one item blocked on data, one deliberately held back, a
> design system that is written but not yet implemented, and a short tail.
> Everything below has been checked against the code rather than carried forward
> from the last review - several items in earlier versions of this file had
> already been built and were still listed as open.

Ordered by what blocks what, not by size.

---

## 1. The layout model — still blocked, but much less of it is needed now

**Field extraction is BUILT and does not need the model.** `ml/app/fields.py`
reads the applicant's name, phone, email and the signing date off a scan today,
with no corpus, by the same trick tick-box reading uses: the form prints its own
field labels, printed text is what OCR is reliably good at, so locate the label
and read the value beside it. Email and phone go further and are matched by
pattern, since an address is self-identifying wherever it sits.

Measured on a rendered membership form at 200 DPI:

    fullName     Priya Sharma               conf 0.96  anchored
    phone        98765 43210                conf 0.95  pattern
    email        priya.sharma@example.org   conf 0.93  pattern
    collectedOn  4 March 2019               conf 0.95  anchored

**What the model is still for.** A form that does NOT print its field labels, or
prints them somewhere unrelated to the value. Anchoring cannot help there, and
that is the remaining job. It still needs 50-100 reviewed scans of one layout,
and the corpus is at 0 - but the common case no longer waits for it.

**Also still true.** Nothing warns you when `ML_SERVICE_URL` is set and the
service is not answering, and a scan reviewed in that window banks no tokens and
cannot be recovered. A health check on the review screen remains worth building.

**Depends on.** Reviewed scans accumulating. **Blocks.** Nothing that matters
day to day any more.

---

## 2. Set-based `commitDraft` — deliberately not done

**What.** Replace the per-purpose loops at `src/lib/intake.ts` with multi-row
statements.

**Why it matters.** Roughly three serialised round trips per purpose inside the
transaction. One clerk committing one form never notices. Bulk import commits row
by row, so ten thousand forms is ~90,000 serialised round trips holding row locks
and blocking concurrent portal withdrawals for those same people.

**Why it is still here.** The withhold-on-withdrawal and supersession rules are
the most safety-critical logic in the app, and they are currently readable
TypeScript. The engineering review found two real bugs in them in that readable
form; a dense CTE would have hidden both. There are now tests
(`commit-draft.test.ts`, `draft-state-machine.test.ts`), which is the stated
precondition — but the payoff is a load profile this deployment does not yet
have, and the risk is silently mis-projecting consent. **Do it when bulk import
is actually being run at volume, not before**, and keep the rules expressible
rather than collapsing them into one clever statement.

**Depends on.** Nothing. **Blocks.** Phase 5 at scale.

---

## 3. Calibrate the tick-box ink threshold — blocked on real paper

**What.** `INK_THRESHOLD` in `ml/app/tickbox.py` is a starting value, not a tuned
one.

**Why it matters.** It separates cleanly on synthetic forms (0.00 empty versus
0.56 ticked). Real scans are messier: a faint pencil tick on a heavy scan sits
much closer to an empty box with a dark border, and the failure is silent in both
directions.

**The tool now exists.** `npm run calibrate` (`scripts/calibrate-tickbox.mjs`)
does the join: for every committed draft it reads the `ink_ratio` the service
recorded in `extraction` against what the reviewer confirmed in `payload`, and
reports the threshold that misclassifies the fewest boxes. It is read-only and
never edits `tickbox.py`; the number it prints is for a human to move across.

It also reports **anchoring** first, which is the more common failure: if the
printed wording on the paper does not match
`consent_notice_purpose.printed_label`, the label is never found and no
threshold can rescue it. Above 20% anchor failure the script says so and tells
you to fix the wording before tuning anything.

Verified on synthetic data in both directions: a clean gap (proposes the
midpoint) and overlapping populations (says no threshold separates them, and
that this is a scan-quality signal rather than a tuning problem).

**Depends on.** Real scans being reviewed. Roughly 10 forms is enough for a
usable direction; the script warns while the sample is under 25 boxes.
**Does NOT depend on** item 1's corpus target of 50-100 - tick-box reading is
ink density, not a trained model.

---

## 3b. The training corpus in `docs/training-data` is the wrong shape

**What is there.** 146 PDFs, 1231 pages, from SBI, HDFC, PNB and SMBC. 139 carry
a digital text layer. A manifest (`pnb/PNB-forms-index.csv`) shows they were
downloaded from the banks' own websites.

**They are BLANK templates.** Nothing is filled in and nothing is ticked, so
they cannot do the three things a corpus is needed for:

- train the layout model - no values, and no human-verified pairs to learn from
- calibrate `INK_THRESHOLD` - nothing ticked, so no ground truth
- measure field-extraction accuracy - there is no applicant data to extract

**What they were genuinely good for**, and this was worth having: harvesting the
real field-label vocabulary. `ml/scripts/harvest_labels.py` mines the printed
layer of all 146 and ranks the wording by how many forms use it. The anchor list
in `src/lib/extraction.ts` now comes from that evidence rather than from
guesswork - "Name of Applicant" (6 forms), "Mobile No" (8), "E-mail ID" (3),
"Date" (76) - instead of the invented "Full name" / "Mobile".

**Two structural findings, both from real paper.**

1. **Comb boxes.** The SBI account-opening form writes a name as thirty
   individual character cells, not a value on a line. Anchoring reads "the
   tokens to the right of the label" and that is simply not where the value is.
   Indian bank forms use this layout constantly. It is a different extraction
   geometry and nothing here handles it yet.
2. **Prose collisions.** The same form prints a section header reading
   "(All communications will be sent on provided Mobile No./Email-ID)". The
   words "Mobile No" match there at full confidence, so the reader anchored on
   a sentence. Punctuation preference and a mid-phrase penalty were added and
   help, but do not fully resolve it when the real field label is unpunctuated
   ("Mobile No." with a period).

**What is actually needed to move Phase 8:** ten or more FILLED copies of ONE
layout, with the values legible, so that a reviewer can confirm them and the
pair (tokens, confirmed payload) can be banked. Blank templates cannot
substitute, however many there are.

---

## 4. Local versus cloud OCR — an organisation's decision, not engineering's

The engine registry (`ml/app/engines/`) exists so the two can be compared on your
own forms. The answer decides whether handwriting is readable at all, and whether
a vendor becomes a Data Processor under s.8(2). Nothing in the code blocks this;
somebody has to run both over real paper and decide.

---

## 5. Implement DESIGN.md — decided, not yet built

`DESIGN.md` was written on 5 September 2026 and **none of it is in the code yet.**
Every value below is currently spec-only; verified against the tree on 6 September.
This is the largest single block of pending work, and it is all low-risk: no
consent logic is touched.

The accessibility half of the /design-review findings is already closed — every
callout goes through `Callout`, `role="alert"` is decided by whether the message
answers something the person just did rather than by its colour, `neutral` carries
a border, and `OtpInput` is built on `Field`. What follows is presentational.

**5a. Type scale (the big one).** DESIGN.md specifies 28 / 20 / 16 / 14 / 12.
The code is still `h1 text-xl` (20px) and `h2 text-sm` (14px, byte-identical to
body), with no `h3` anywhere. The migration is a promotion: today's `h1` becomes
`h2`, today's `h2` becomes body. Touches **26 `h1` usages and 2 `h2`**. While in
there, one `h1` uses `text-2xl` while the other 25 use `text-xl` — fix that
inconsistency in the same pass. The public portal runs one step up (body 16px,
`h1` 24px on a phone), which is a Safari auto-zoom requirement, not taste.

**5b. Warm the canvas.** `--canvas` is still `#f6f7f9` in `globals.css:16`;
DESIGN.md specifies `#f7f6f3`. One line. Leave `--ink` and `--line` neutral.

**5c. One Panel, two paddings.** 16px dense / 24px calm. Today there are **12
hand-rolled panel shells across 5 paddings** (`p-4` ×7, `px-5 py-4` ×2, `p-6`,
`p-5`, `px-3 py-2`); the `Panel` primitive itself is `px-5 py-4`. All twelve
should be the primitive.

**5d. Print sheets (R3).** No `@media print` rules exist anywhere in the tree.
DESIGN.md makes print the export path: every record and queue gets a real print
sheet whose footer carries register ID, paper date, digitisation timestamp and
payload hash, in IST with the zone named. This is the item that most directly
serves "this will hold up", and the only one here with real design work left.

**5e. Odds and ends already ruled on.** The landing CTA must be built from
`Button` (it is `px-5 py-3` instead of `px-4 py-2`); ghost buttons underline on
hover, since the codebase already votes 8 to 1 against `hover:bg-blue-soft`.

**Still open, no ruling yet** — DESIGN.md does not cover these:

- **Withdrawal is a dead end.** After withdrawing, the only action is "Back to the
  start". The principal token is valid for another 15 minutes, so "See my updated
  record" would close the loop; instead the person must request a fresh code to
  see what changed.
- **Draft review below 1024px.** `draft-form.tsx` has one layout breakpoint; under
  `lg` the scan panel and commit button stack *after* four form panels, so the
  operator transcribes the paper with the scan off-screen. A fixed `h-96` iframe
  compounds it at 375px.
- **Date entry order.** `lang="en"` renders 4 March 2019 as `3/4/2019`. For an
  India-first register whose whole job is recording paper dates, the field needs
  an explicit format hint. The widget's own order is browser-locale controlled and
  cannot be forced from the page.

Declined and recorded in DESIGN.md so nobody re-proposes them cold: Source Serif 4
on `h1`/`h2`, receipts instead of toasts, dark mode.

Audit report and before/after screenshots:
`~/.gstack/projects/Code-base/designs/design-audit-20260905/`.
Style guide: `~/.gstack/projects/ajitbubu-offline-consent/designs/design-system-20260905/style-guide.html`.

---

## 6. Route-level tests

Library coverage is now complete: every module in `src/lib/` is imported by at
least one spec. What has no tests is the route handlers themselves — the Origin
checks, the role gates and the status codes are verified only through the
functions they call.

**Why it is still open.** It needs a Next 16 App Router request-context harness
that does not exist here. That scaffolding is the actual work, not the specs.

---

## 7. Smaller things

- **The tick-box threshold is now demonstrably too low.** On a rendered form
  with boxes 1 and 3 ticked, real ticks measured `ink_ratio` 0.556 and empty
  boxes 0.000 - but one box whose printed label wraps to two lines measured
  0.100, and `INK_THRESHOLD = 0.08` called it consented. That is a wrongly
  recorded consent from a single clean form. Anything between 0.11 and 0.55
  fixes this sample; `npm run calibrate` picks the value from real reviewed
  scans. Do not tune it from this one synthetic case.
- **`countDuplicates` in `src/lib/duplicates.ts` is exported and never called.**
  The duplicates page renders pairs without a total. Either surface the count on
  the dashboard beside the other queue numbers, or delete the function.
- **A merge cannot be undone from the interface**, which is correct, but there is
  also no way to see the merge history of a record beyond the audit trail.
- **`dev-dpo@example.org` exists in `staff_user` on the local database.** Created
  during a run-and-test session because the seeded administrator password is shown
  once and cannot be recovered. It has transcribed nothing, so unlike the test
  residue below it *is* deletable. Remove it or keep it as a local login, but do
  not let it reach anything but a laptop.
- **Test residue accumulates on a developer's database, and mostly cannot be
  deleted.** The specs that must commit (the bulk importer's
  separate-transaction behaviour, the OTP counter across connections) cannot use
  `withRollback`, because one shared client serialises the very concurrency they
  test. They clean up their drafts, but the `staff_user` row is pinned by
  `consent_artifact.transcribed_by ON DELETE RESTRICT` against an append-only
  table, so it can never be removed - correctly, since evidence has to name who
  transcribed a form. `npm run db:reset` is the remedy. Not a bug; worth knowing
  before someone tries to write a cleverer teardown.

---

## Closed since the engineering review

Recorded so nobody re-opens them from an old copy of this file.

- **Duplicate detection.** `findDuplicates` in `src/lib/duplicates.ts` does the
  trigram report, deliberately refusing to flag a shared contact point on its own
  as a duplicate — a shared household number is ordinary in India, and a report
  that flags every household trains a DPO to dismiss the list. Wired to
  `/staff/duplicates` and tested.
- **Both dead dedup primitives.** `payload_hash` refuses an artifact identical to
  one already on file for that person; `evidence_object_sha256_idx` makes a
  re-uploaded file reuse the existing row instead of writing the bytes again.
- **`principal_lookup_request` is no longer write-only.** It has a read path
  (`src/lib/lookup.ts`), a worked queue at `/staff/lookup-requests` with resolve
  and reject, an Origin check, a per-address daily limit counted off a hashed
  address (migration 013), and an audit entry at filing and at both outcomes. The
  dashboard surfaces the count, and flags anything waiting over a week.
- **`libphonenumber-js`** now backs `normalisePhone`, using the `/mobile`
  metadata rather than `min`. `min` validates only shape, so `+9999999999999`
  passed; `mobile` knows which ranges exist and which can receive SMS, so it also
  refuses a valid Indian *fixed line* — the number that would otherwise be
  stored and never receive a code.
- **CI** enforces `lint && typecheck && build && test` on every push.
- **The dead `/staff/principals` nav route**, which 404'd for every DPO.
- **Library test coverage.** `evidence`, `audit`, `catalogue`, `http`, `notices`
  and `register` all have specs. To make the last four testable inside the
  rollback fixture they took the optional `Executor` parameter the rest of the
  codebase already used; `recordPrincipalView` in particular was pool-bound and
  therefore untestable, since `audit_log` refuses `DELETE` and nothing could be
  cleaned up afterwards.
