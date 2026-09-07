# offline-consent

A consent register for consent that was collected **on paper**.

Paper consent is invisible to the person who gave it: someone who signed a form
in 2019 has no way to see what they agreed to and no way to take it back. Under
India's **DPDP Act 2023** that is a live gap — s.6(4) requires withdrawal to be
*as easy as giving* consent, and s.5(2) requires a notice for personal data held
from before commencement.

This app digitises those forms into a durable register and puts a public portal
in front of it, so the Data Principal can find their record with a one-time code
and withdraw consent per purpose.

## Running it

```bash
docker compose up -d && npm install && npm run migrate && npm run seed && npm run dev
```

Extraction (`./ml`, OCR and tick-box reading) is optional and comes up with
`docker compose up -d`. Point `ML_SERVICE_URL` at it to start banking OCR
tokens; leave it unset and the review screen is plain manual entry. See
[`ml/README.md`](ml/README.md) — and note that a scan reviewed without it
running is a training pair lost for good.

The seed prints an administrator password once, and only when `staff_user` is
empty - re-seeding never resets it, so keep it. The app runs on
<http://localhost:1002>.

`npm run db:reset` drops the schema and rebuilds it empty (then re-run migrate
and seed). You will want it eventually: specs that must commit - the bulk
importer's separate-transaction behaviour, the OTP counter's behaviour across
connections - cannot roll back, and their residue cannot be deleted row by row
either, because `consent_artifact` is append-only and its `transcribed_by`
references `staff_user` ON DELETE RESTRICT. That is the evidence model working
as designed; the remedy is a new database, not a smarter cleanup. It refuses any
host that is not local unless `ALLOW_REMOTE_RESET=yes`.

| | |
|---|---|
| `/` | Public landing |
| `/withdraw` | The Data Principal's portal — one-time code, then withdraw |
| `/notice/:code/:version` | Public, versioned notice text |
| `/staff/login` → `/staff` | Operator and DPO screens |

Checks: `npm run lint && npm run typecheck && npm run build && npm test`,
and `cd ml && uv run pytest` for the extraction service.

## How it fits together

### Artifact vs. record — the split everything rests on

One paper form produces two kinds of row:

```
   ONE paper form
        ├──► consent_artifact       1 row,  IMMUTABLE — what the paper said
        │      └─ consent_artifact_item   one per tick-box
        └──► consent_record         N rows, MUTABLE — current state per purpose
```

When someone withdraws, "granted" must both **change** (so processing stops) and
**not change** (so you can still prove consent was validly obtained on 4 March
2019). Those are different rows. A correction is a **new artifact**, never an
`UPDATE`.

### Extraction proposes, a human disposes

The `ml/` service reads a scan and writes what it found to
`intake_draft.extraction`. It never touches `payload`, and `commitDraft()` reads
`payload` alone — so a value becomes consent only when a reviewer moves it
across. The service is also told nothing it could use to name a purpose: labels
go over the wire as an ordered list and come back by index.

That arrangement is also what solves the cold start. The review screen already
shows the scan beside the form, so every committed draft pairs OCR tokens with a
human-verified payload, and that pair is the training set for the text model
that does not exist yet.

### One intake pipeline

Manual entry, scan review, bulk CSV and kiosk capture all produce an
`intake_draft` with the same payload shape, and **`commitDraft()` in
`src/lib/intake.ts` is the only thing that writes `consent_artifact`**. There is
no bypass, including for the kiosk. Adding an intake mode means filling
`payload` differently — never adding a second write path.

## Invariants — do not break these

1. **`consent_artifact`, `consent_artifact_item` and `audit_log` are append-only**,
   enforced by statement-level triggers, not convention.
2. **Audit tables carry no foreign key to `data_principal`.** Evidence must
   outlive erasure of the identity it describes.
3. **A consent write and its audit entry share one transaction.** Everything
   that mutates consent takes an `Executor` so a caller can compose them.
4. **Side effects are enqueued only after commit**, never inside the transaction.
5. **Absence of consent is not consent.** Enforcement reads `consent_record` and
   denies by default.
6. **A newly digitised form never resurrects a withdrawn consent.** If the
   person withdrew after the form was signed — or the form is undated, so it
   cannot be shown to predate the withdrawal — the withdrawal stands.
7. **Two credential classes never cross.** Staff and Data Principal tokens are
   separated by JWT audience, and each verifier independently asserts the shape
   it expects. A principal's identity comes from `payload.sub` and nowhere else.
8. **The portal is not an enumeration oracle.** A code request answers
   identically, in the same time, whether or not the destination is in the
   register, and writes no row for one that is not.
9. **A phone number that will not normalise is a blocking error.** Storing it
   would make that person permanently unreachable and s.6(4) unsatisfiable for
   them, silently.
10. **Withdrawal is not erasure.** s.6(5) means past processing stays lawful; the
    UI says so and never implies deletion.
11. **Duplicate people are never merged automatically.** Fusing two records
    leaks one person's consent state into another's.
12. **Migrations are forward-only and checksummed.** Never edit an applied one.

## Deliberate deviations

- **`next@16.3.4`, not `16.2.10`** as in the sibling repos. That version carries
  nine high-severity advisories including unauthenticated disclosure of internal
  Server Function endpoints, which is not acceptable for an app holding consent
  evidence.
- **Vitest is present**, unlike the other Next.js repos here. `lint && build`
  cannot catch a wrong commit transaction, and two real bugs (a dead brute-force
  counter, a dead supersession rule) were found exactly this way.
- **CSV only, not `.xlsx`.** Say the word and it can be added.
- **`payload_hash` changed meaning once.** It now covers the verbatim tick-box
  wording, the date precision, the notice-at-collection value and the collection
  location, none of which it covered before. Hashes written either side of that
  change are not comparable; compare artifacts by content, not by hash, across
  it.

## Status

Phases 0-7 are shipped and FR-1 to FR-16 are built: schema, staff auth, evidence
storage, all four intake routes (manual, scanned, bulk CSV, kiosk), review and
commit, the public withdrawal portal, and the DPO surfaces — register search,
principal detail, duplicate detection and merge, the s.5(2) notice queue, the
s.6(6) cessation queue, and the lookup-request queue behind the portal's escape
hatch.

Phase 8 is half built. OCR, tick-box reading and the training export all work;
the **layout model for handwritten text does not exist**, because it needs 50-100
reviewed scans and the corpus starts at zero. Bring `ml` up before reviewing
scans — a scan reviewed with the service down is a training pair lost for good.

One thing is deliberately not done: `commitDraft` still commits per purpose
rather than in set-based statements. That matters only at bulk-import volume, and
the rules it would compress are the most safety-critical logic in the app. See
`TODOS.md` §2 and `docs/PRD.md` §12.
