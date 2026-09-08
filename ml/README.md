# ml — OCR and tick-box extraction

Reads a scanned consent form and returns two things: word-level OCR tokens, and
a reading of each tick-box. It decides nothing. The app decides everything.

```
  scan bytes ──► render ──► engine.tokens() ──► tokens ─┐
  (png/jpg/pdf)  (PyMuPDF)  (tesseract)                 ├──► app
  printed labels ─────────► anchor + ink density ───────┘
                            (no model, no training)
```

## Why this exists before the model does

Text extraction needs labelled forms and there are none — the classic cold
start. The way out is already designed into the app: the review screen shows the
scan beside the form, so **every committed draft pairs OCR tokens with a
human-verified payload**, and that pair is the training set.

Which means the expensive part is not the model. It is the corpus, and the
corpus only accumulates if tokens are captured *now*. Every scan reviewed
without this service running is a training pair thrown away and cannot be
recovered later — the reviewer's corrections are gone.

So this ships in two halves, and the first half is the urgent one:

1. **Token capture.** Works today, needs no notice version, no model, no
   training. Just run it.
2. **Tick-box reading.** Also works today, because a consent form tells you
   where to look (below).
3. Text-field extraction. Waits for roughly 50–100 real scans. Not built.

## Reading a tick-box without a trained model

Every purpose on a notice version carries the exact wording printed beside its
box (`consent_notice_purpose.printed_label` — which is why that column has a
trigram index). Printed text is what OCR is reliably good at. So:

```
    +---+
    | X |  I agree to receive marketing communications
    +---+  ^
      ^    1. fuzzy-match the printed label against the token stream
      |
      2. search left of the anchor, one line-height tall
      3. find the box from the ink in that band (leftmost column run)
      4. measure ink INSIDE it, border cropped away
```

Step 3 is the one that matters. Sliding a fixed window and taking whichever
position held the most ink does not work: the window drifts off the box, catches
the border in what it treats as the interior, and an empty box reads as ticked.
Locating the box from its own ink first makes the interior crop aligned by
construction — empty boxes then measure 0.00 against a threshold of 0.08.

**`INK_THRESHOLD` is not calibrated.** It is a starting value that separates
cleanly on synthetic forms. Real scans are messier: a faint pencil tick on a
heavy scan sits much closer to an empty box with a dark border. `ink_ratio` is
returned on every reading so the threshold can be set from your own forms.
Until it has been, treat every reading as a suggestion for a human — which is
what the review screen does with it anyway.

## Two rules it will not break

- **It never sees a database identifier** (PRD SEC-9). Labels go over the wire
  as an ordered list and come back by `index`; mapping an index onto a purpose
  is the app's job, on the app's side, against the rows it sent. A confused or
  compromised service cannot name a purpose nobody asked about.
- **It never writes consent.** Output lands in `intake_draft.extraction` and
  stays there. `commitDraft()` reads `payload` alone, and a value moves across
  only when a reviewer accepts it.

## Local versus cloud is not settled

`app/engines/` is a registry behind one interface, and tesseract is the first
entry, not the answer. The trade runs in opposite directions:

- **Local** keeps images of signed consent forms inside the building. Strong on
  the printed parts of a form; weak on handwriting, which is most of what a
  *filled* form carries.
- **Cloud document AI** reads handwriting materially better, and makes that
  vendor a Data Processor under DPDP s.8(2) — a contract, a DPO sign-off, and a
  per-scan cost.

Decide it on numbers from your own forms rather than on anyone's priors. Both
behind one interface is what makes that comparison possible, and the tokens
banked in the meantime stay useful whichever wins.

## Running it

```bash
docker compose up -d ml          # or, for development:
uv venv && uv pip install -e . && uv run uvicorn app.main:app --port 8000
uv run pytest
```

Then set `ML_SERVICE_URL=http://localhost:8000` in the app's `.env`. With it
unset the app skips extraction entirely and the review screen is the manual
entry form — the same screen, which is why `intake_draft` has no `extracting`
status. One degradation path, not two.

## API

`GET /health` → engine name and version, available engines, schema version.

`POST /extract` (multipart) → `file`, `content_type`, `labels`
(`[{index, text}]`), optional `engine`.

```json
{
  "schema_version": 1,
  "engine": "tesseract", "engine_version": "5.5.3",
  "pages": [{ "page": 1, "width": 1700, "height": 2200,
              "tokens": [{ "text": "marketing", "bbox": [10,20,90,45], "confidence": 0.96 }] }],
  "tickboxes": [{ "index": 0, "granted": true, "confidence": 0.98,
                  "anchor_score": 0.98, "ink_ratio": 0.556,
                  "page": 1, "bbox": [150,460,196,506] }]
}
```

`granted: null` means the printed label was not found. That is **not** the same
as finding the box and seeing it empty, and the app renders the two differently
— collapsing them would turn a failed match into a recorded refusal.

Page dimensions travel with the tokens on purpose: a bbox is pixels in some
raster, and `evidence_object` records no geometry. A stored blob has to stay
readable years from now, after the renderer's default DPI has moved on.
