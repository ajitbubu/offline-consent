# TODOS

Deferred work, with enough context to pick up cold. Written during the
engineering review that produced the `fix/eng-review-p0` branch; the eighteen
defects that branch closes are not listed here.

Ordered by what blocks what, not by size.

---

## 1. Split identities are structurally guaranteed, and currently undetectable

**What.** One human can become two `data_principal` rows, and nothing in the
system can find them or count them.

**Why it matters.** The second identity's consents are invisible to the portal
and cannot be withdrawn. That is a silent s.6(4) failure for a person who did
everything right.

**Context.** Uniqueness is `(phone_e164, name_key)` and `(email, name_key)`
(`migrations/001:78-81`) — deliberately not contact point alone, because a
shared household phone is ordinary in India and making phone globally unique
would fuse two real people. `matchPrincipal` (`src/lib/intake.ts:191`) then
requires an *exact* normalised name. So a second row is created whenever:

- form A carries a phone and form B carries an email — neither matches the
  other's index, so neither finds the other; or
- the name is transcribed with a variant a reviewer waves past with `forceNew`.

`requestOtp` (`src/lib/otp.ts:113-119`) matches a single contact point, so a
code sent to the phone reaches only identity #1. There is no register search, no
duplicate report, and no merge screen. `resolvePrincipalId`
(`src/lib/principal.ts`) now follows a merge chain correctly — but only once a
merge has been performed, and nothing can perform one.

**Pros of doing it.** Makes the failure visible before it becomes a complaint;
gives the DPO the tool the schema was already designed for (`merged_into_id`).

**Cons.** Duplicate detection at register scale is its own piece of work, and a
merge that fuses two people who are genuinely different is worse than the
duplicate (Invariant 11).

**Depends on.** Nothing. **Blocks.** Item 2.

**Where to start.** A read-only report first: contact points shared across rows
whose `name_key` differs by a small trigram distance. Count before building the
merge.

---

## 2. Resequence the roadmap: Phase 7 before Phase 5

**What.** Build the DPO surfaces (register search, notice queue, cessation,
merge) before bulk CSV import.

**Why it matters.** Bulk CSV pushes thousands of forms through the exact-name
matcher described in item 1, with a duplicate gate designed for one-at-a-time
human review — `commitDraft` throws `possible_duplicate` per draft
(`src/lib/intake.ts:361`) — and no bulk merge tool on the other side. Every
duplicate it creates is an unwithdrawable consent record that nobody can see.

**Context.** `docs/PRD.md` §12 currently orders 5 → 6 → 7 → 8. The evidence that
the schema anticipated this and the code never caught up:

- `evidence_object_sha256_idx` (`migrations/004:50`) is commented *"Detects a
  re-upload of a form already on file"* and is **never queried**.
- `consent_artifact.payload_hash` is computed at `src/lib/intake.ts:393` and
  **never read back**. Nothing stops two artifacts being committed for the same
  physical form.

Both are exactly the primitives a bulk importer needs, and both are dead. See
item 3.

**Pros.** Phase 5 becomes safe to build and its duplicate handling has somewhere
to send its output.

**Cons.** Delays the feature with the most obvious customer pull.

**Depends on.** Item 1 (at least the read-only report).

---

## 3. Two dead deduplication primitives

**What.** Wire up `evidence_object.sha256` and `consent_artifact.payload_hash`
as actual duplicate checks.

**Why it matters.** Re-uploading the same scan, or committing the same form
twice, both currently succeed and re-run the whole projection.

**Context.** Both columns are written and indexed; neither is ever read. The
hash now covers the printed wording, precision, notice and location, so it is a
usable identity for "this exact form" — note that hashes written before that
change are not comparable with ones written after.

**Pros.** Small, and it makes item 2's importer idempotent.

**Cons.** A legitimate re-submission (a corrected transcription of the same
paper) must stay possible, so this is a warning to the reviewer, not a hard
block.

**Depends on.** Nothing. **Blocks.** A safe Phase 5.

---

## 4. `principal_lookup_request` is write-only

**What.** Nothing reads the table. It also has no Origin check, no rate limit
and no audit entry.

**Why it matters.** Migration 010's own header says it is *"not optional:
without it a transcription typo permanently blocks a statutory right."* It is
the only escape hatch for someone whose contact point was mistranscribed — and
their request currently lands in a table no human will ever open.

**Context.** `grep -rn principal_lookup_request src` returns exactly one hit:
the INSERT at `src/app/api/portal/lookup-request/route.ts:24`. The endpoint
accepts 2000 characters of free text from anyone, unauthenticated and
unthrottled, so flooding it is trivial — and flooding it destroys the fallback
for exactly the people who most need it.

**Pros.** A read-only queue screen is small and reuses the existing staff auth
and layout.

**Cons.** Invites scope creep toward the full Phase 7 DPO surface, which
deserves designing properly.

**Depends on.** Nothing.

---

## 5. Set-based `commitDraft` — prerequisite of bulk import

**What.** Replace the per-purpose loops with multi-row statements.

**Why it matters.** `src/lib/intake.ts:436-560` does roughly three serialised
round trips per purpose inside the transaction. One clerk committing one form
never notices. Ten thousand forms is ~90,000 serialised round trips holding row
locks, blocking concurrent portal withdrawals for those same people, and failing
atomically after a long wait — the worst shape a batch job can have.

**Pros.** Turns the bulk import from a lock-holding monolith into something
survivable.

**Cons.** The withhold-on-withdrawal and supersession rules are the most
safety-critical logic in the app and are currently readable TypeScript. This
review found two real bugs in them in that readable form; a dense CTE would have
hidden both. Do not do this until there are tests you trust, and keep the rules
expressible.

**Depends on.** Nothing. **Blocks.** Phase 5 at scale.

---

## 6. Text-field extraction, once the corpus exists

**What.** Layout classification for the handwritten fields — name, phone, date.

**Why it deferred.** It needs roughly 50–100 reviewed scans and there were none,
because `ocr_tokens` was never written. Token capture now runs on every scan
upload, so the corpus accumulates from here; `intake_draft_trainable_idx`
already indexes exactly the rows to export (`status = 'committed' AND ocr_tokens
IS NOT NULL`).

**Where to start.** A training-export job over that index, and a count. Do not
train until the count is real: a model fitted on under ten forms will be
confidently wrong, and a confidently wrong pre-filled name is worse than an
empty field because reviewers stop checking things that are usually right.

**Also waiting on this.** The local-versus-cloud engine choice
(`ml/app/engines/`). Both sit behind one interface so they can be compared on
your own forms; the answer decides whether handwriting is readable at all, and
whether a vendor becomes a Data Processor under s.8(2).

**Depends on.** Token capture running in production for long enough to bank a
corpus. **Blocks.** Nothing.

---

## 7. Calibrate the tick-box ink threshold

**What.** `INK_THRESHOLD` in `ml/app/tickbox.py` is a starting value, not a
tuned one.

**Why it matters.** It separates cleanly on synthetic forms (0.00 empty versus
0.56 ticked). Real scans are messier: a faint pencil tick on a heavy scan sits
much closer to an empty box with a dark border, and the failure is silent in
both directions.

**Where to start.** `ink_ratio` is returned on every reading and stored in
`intake_draft.extraction`. Once real scans have been through, compare the stored
`ink_ratio` against what the reviewer actually confirmed in `payload` — that
join gives the threshold directly, and it also gives a standing measure of
extraction quality.

---

## 8. Smaller items

- **`libphonenumber-js` for `src/lib/phone.ts`.** `normalisePhone` accepts any
  `+`-prefixed E.164-shaped string with no country validation
  (`src/lib/phone.ts:17`), so `+9999999999999` passes. Today's code refuses
  rather than guesses, which is the right failure direction, so this is an
  improvement and not a bug fix.
- **CI pipeline.** Nothing enforces `AGENTS.md`'s definition of done
  (`lint && typecheck && build && test`). Now unblocked: the project is a git
  repository as of the baseline commit.
- **`evidence.ts` and route-level tests.** Still at zero. Route testing needs a
  Next 16 App Router request-context harness that does not exist here yet; that
  scaffolding is the actual work.
