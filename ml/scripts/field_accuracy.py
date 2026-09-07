"""
Does extraction read the RIGHT VALUE - not merely find the right label?

WHY THIS REPLACES THE COVERAGE HARNESS AS THE NUMBER THAT MATTERS. Coverage
measures whether a printed label can be located, which is a precondition and
nothing more. Two genuinely filled forms showed the gap: coverage read 33.2%
and accuracy was 0 of 6. Worse, tuning against BLANK templates had produced a
rule that actively harmed filled ones - the band beside "Full name" contains
the name, and a classifier taught on empty forms called that prose.

So this fills forms itself and checks what comes back.

HOW THE GROUND TRUTH IS BUILT, and why it is trustworthy:

  1. Find the printed label in the PDF TEXT LAYER - exact characters, not OCR.
     OCR is the thing under test and cannot also be the answer key.
  2. Find that label's answer box, by the form's own construction: the
     fillable widget nearest to its right or below, or - on the far more
     numerous forms with no widgets - the EMPTY table cell beside it.
  3. Write a known value into it and save.
  4. Render to an image, run the extractor, compare against what was written.

WHAT THIS DOES AND DOES NOT TEST. A widget renders as clean typed text, so this
measures FIELD LOCATION and reading - can the extractor find the right box on
this layout and return what is in it. It does NOT test handwriting; no synthetic
fill can. Handwriting needs real filled paper, and that remains the blocker for
the layout model in TODOS.

    cd ml && uv run python scripts/field_accuracy.py ../docs/training-data
    cd ml && uv run python scripts/field_accuracy.py ../docs/training-data --json acc.json
    cd ml && uv run python scripts/field_accuracy.py ../docs/training-data --keep /tmp/filled
"""

from __future__ import annotations

import io
import json
import re
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

import pymupdf
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import fields as fields_reader
from app.contract import Page
from app.engines import get_engine
from scripts.field_coverage import REQUESTS

DPI = 200

# What gets written into each kind of field. Distinctive on purpose: if the
# extractor returns one of these it can only have come from the box we wrote it
# into, so a match cannot be a coincidence of the form's own printed text.
FILL = {
    "fullName": "Rajesh Venkataraman",
    "phone": "9876543210",
    "email": "rajesh.v@example.org",
    "collectedOn": "04/03/2019",
}

# Which printed labels mark which field. Deliberately NOT the app's anchor list:
# an answer key built from the same strings the extractor searches for would
# only ever prove the strings match themselves.
TRUTH_LABELS = {
    "fullName": re.compile(r"\b(full\s*name|name\s+of\s+(the\s+)?(applicant|enterprise|depositor)|applicant\s+name)\b", re.I),
    "phone": re.compile(r"\b(mobile\s*(no|number)?|telephone\s*(no|number)?|phone\s*(no|number)?)\b", re.I),
    "email": re.compile(r"\be-?\s?mail(\s*(id|address))?\b", re.I),
    "collectedOn": re.compile(r"\bdate\b", re.I),
}

# A label and its answer box are close. Beyond this, on the same page, they are
# unrelated things that happen to be near each other.
MAX_GAP_X = 420
MAX_GAP_Y = 40


def _plant(doc: pymupdf.Document) -> dict[str, str]:
    """Write known values into the widgets their printed labels point at.

    Only where the label is UNIQUE in the document. Without that rule the
    harness invents failures it then blames on the extractor: "Date" appears
    twenty times on an account-opening form, the planter writes into the first
    one, the extractor reads a different one, and a correct read of a different
    date is scored wrong. A key that appears twice is a question this harness
    cannot mark, so it does not ask it.
    """
    planted: dict[str, str] = {}

    # Which keys are unambiguous in this document.
    hits: dict[str, int] = {k: 0 for k in TRUTH_LABELS}
    for page in doc:
        for block in page.get_text("blocks"):
            text = (block[4] or "").strip()
            for key, pattern in TRUTH_LABELS.items():
                if text and pattern.search(text):
                    hits[key] += 1
    unique = {k for k, n in hits.items() if n == 1}

    for page in doc:
        try:
            widgets = [w for w in page.widgets() if w.field_type_string == "Text"]
        except Exception:
            continue
        if not widgets:
            continue

        for key, pattern in TRUTH_LABELS.items():
            if key in planted or key not in unique:
                continue
            for block in page.get_text("blocks"):
                text = (block[4] or "").strip()
                if not text or not pattern.search(text):
                    continue
                lx0, ly0, lx1, ly1 = block[0], block[1], block[2], block[3]

                # The answer box: to the right on the same line, or directly
                # below. Nearest wins - a form puts the box beside its label.
                best = None
                best_distance = 1e9
                for w in widgets:
                    wx0, wy0, wx1, wy1 = w.rect
                    right = wx0 >= lx1 - 4 and abs((wy0 + wy1) / 2 - (ly0 + ly1) / 2) <= MAX_GAP_Y
                    below = wy0 >= ly1 - 4 and abs(wx0 - lx0) <= MAX_GAP_X and wy0 - ly1 <= MAX_GAP_Y
                    if not (right or below):
                        continue
                    distance = abs(wx0 - lx1) + abs(wy0 - ly0)
                    if distance < best_distance:
                        best, best_distance = w, distance

                if best is not None and not (best.field_value or "").strip():
                    best.field_value = FILL[key]
                    best.update()
                    planted[key] = FILL[key]
                    break
    return planted


# Smaller than this and the value is not legible at 200 DPI, so a failed read
# would be the harness's doing rather than the extractor's. Measured: at 6pt,
# 10 of 18 planted addresses were never resolved by OCR anywhere on the page.
_MIN_FONT = 8.0


def _write_into(page: pymupdf.Page, box: pymupdf.Rect, text: str) -> bool:
    """Draw `text` inside `box`, or report that it would not fit.

    The return value is the whole point, and ignoring it was a bug that
    invented 31 failures out of 58 plants. `insert_textbox` fits text to a
    rectangle and returns a NEGATIVE number when it cannot - and a 9pt line
    does not fit a 13pt table cell once the textbox's own padding is counted.
    Nothing was drawn, no exception was raised, and the harness went on to
    score a blank form as a field the extractor had missed. The corpus-wide
    number that came out of that (13.2%) was measuring this function.

    So: shrink to fit, and when even the floor is too big, return False so the
    caller asks no question rather than one the form has no room to answer.
    """
    usable = box.width - 6
    if usable <= 0 or box.height < _MIN_FONT + 2:
        return False

    size = min(9.0, box.height - 3)
    while size >= _MIN_FONT and pymupdf.get_text_length(text, fontsize=size) > usable:
        size -= 0.5
    if size < _MIN_FONT or pymupdf.get_text_length(text, fontsize=size) > usable:
        return False

    # insert_text places one line on a baseline and does no fitting, so what is
    # measured above is what lands on the page.
    page.insert_text((box.x0 + 3, box.y1 - (box.height - size) / 2 - 1), text, fontsize=size)
    return True


def _plant_cells(doc: pymupdf.Document, already: dict[str, str]) -> dict[str, str]:
    """Plant into the empty table cell the form itself left for the answer.

    Widgets are perfect ground truth but rare: 10 forms in a corpus of 146 carry
    them, and 12 planted fields is too small a sample to steer a change by - one
    field is eight percentage points. Tuning against a number that noisy is the
    same mistake as tuning against blank templates, one step further along.

    Table structure is the other exact source, and it is already trusted in this
    codebase: harvest_labels.table_labels_in() mines the anchor vocabulary from
    the same shape - a cell with text beside a cell that is EMPTY is a label and
    its answer space. That empty rect is where the form intends the answer to
    go, stated by the form rather than guessed by us, so drawing a known value
    into it produces a filled form whose layout nobody has touched.
    """
    planted = dict(already)
    for page in doc:
        try:
            tables = page.find_tables().tables
        except Exception:
            continue
        for table in tables:
            try:
                rows = table.extract()
            except Exception:
                continue
            for r, row in enumerate(rows):
                cells = [(c or "").strip() for c in row]
                for c, text in enumerate(cells):
                    if not text or c + 1 >= len(cells) or cells[c + 1]:
                        continue
                    for key, pattern in TRUTH_LABELS.items():
                        if key in planted or not pattern.search(text):
                            continue
                        try:
                            rect = table.rows[r].cells[c + 1]
                        except Exception:
                            rect = None
                        if rect is None:
                            continue
                        box = pymupdf.Rect(rect)
                        if _write_into(page, box, FILL[key]):
                            planted[key] = FILL[key]
                        break
    return planted


def _render(doc: pymupdf.Document, limit: int = 2):
    engine = get_engine()
    pages, images = [], {}
    for index in range(min(limit, doc.page_count)):
        pix = doc[index].get_pixmap(dpi=DPI)
        image = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
        images[index + 1] = image
        pages.append(
            Page(page=index + 1, width=image.width, height=image.height, tokens=engine.tokens(image))
        )
    return pages, images


def _normal(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _same(got: str | None, want: str) -> bool:
    if not got:
        return False
    a, b = _normal(got), _normal(want)
    return a == b or (len(b) >= 6 and b in a) or (len(a) >= 6 and a in b)


def _ocr_saw(page_text: str, want: str) -> bool:
    """Did OCR resolve the planted value anywhere on the page?

    Fuzzy on purpose: Tesseract turned `rajesh.v@example.org` into
    `rajepsh.v@example.org` on one form, and that IS a successful location of
    the field with a character error. Any six-character run surviving intact is
    enough to say the ink was read.
    """
    b = _normal(want)
    return any(b[i : i + 6] in page_text for i in range(max(1, len(b) - 5)))


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    root = Path(sys.argv[1])

    def flag(name, default=None):
        return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

    out_json = flag("--json")
    keep = flag("--keep")
    if keep:
        Path(keep).mkdir(parents=True, exist_ok=True)

    right: dict[str, int] = defaultdict(int)
    wrong: dict[str, int] = defaultdict(int)
    missed: dict[str, int] = defaultdict(int)
    unreadable: dict[str, int] = defaultdict(int)
    declined = 0
    forms = 0
    misreads: list[str] = []

    for path in sorted(root.rglob("*.pdf")):
        try:
            doc = pymupdf.open(path)
        except Exception:
            continue
        try:
            planted = _plant_cells(doc, _plant(doc))
            if not planted:
                continue
            forms += 1

            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                doc.save(tmp.name)
                filled = pymupdf.open(tmp.name)
            if keep:
                filled.save(str(Path(keep) / path.name))

            pages, images = _render(filled)
            results = {r.key: r for r in fields_reader.read(pages, REQUESTS, images)}
            filled.close()

            # What OCR could see anywhere on the page, at all. A value the
            # engine never resolved is not a field extraction got wrong - it is
            # a character-recognition failure, and the two need opposite fixes.
            # Keeping them in one bucket is how "extraction is at 13%" hides
            # "Tesseract cannot read 9pt type in a table cell".
            seen = _normal(" ".join(t.text for pg in pages for t in pg.tokens))

            for key, want in planted.items():
                got = results.get(key).value if results.get(key) else None
                if _same(got, want):
                    right[key] += 1
                elif not _ocr_saw(seen, want):
                    unreadable[key] += 1
                elif got is None:
                    missed[key] += 1
                else:
                    wrong[key] += 1
                    if len(misreads) < 12:
                        misreads.append(f"{path.name[:34]:<36} {key:<12} got {str(got)[:26]!r}")
            sys.stdout.write(".")
            sys.stdout.flush()
        finally:
            doc.close()

    print(f"\n\nFilled and read {forms} forms that carry fillable widgets.\n")
    print(f"  {'field':<12} {'scored':>8} {'RIGHT':>7} {'wrong':>7} {'missed':>7} {'no-ocr':>7}   accuracy")
    current: dict[str, float] = {}
    total_r = total_n = 0
    for request in REQUESTS:
        k = request.key
        # no-ocr is excluded from the denominator on purpose: it is not a
        # failure of extraction, and counting it as one would score this
        # harness's own font choices as the extractor being wrong.
        n = right[k] + wrong[k] + missed[k]
        if n == 0:
            print(f"  {k:<12} {'-':>8} {'':>7} {'':>7} {'':>7} {unreadable[k]:>7}")
            continue
        pct = right[k] / n * 100
        current[k] = round(pct, 1)
        total_r += right[k]
        total_n += n
        print(f"  {k:<12} {n:>8} {right[k]:>7} {wrong[k]:>7} {missed[k]:>7} {unreadable[k]:>7}   {pct:5.1f}%  {'#' * int(pct / 5)}")

    overall = round(total_r / total_n * 100, 1) if total_n else 0.0
    current["_overall"] = overall
    print(f"\n  OVERALL     {total_n:>8} {total_r:>7} {'':>7} {'':>7} {'':>7}   {overall:5.1f}%\n")
    print("  no-ocr = the planted value was never resolved by OCR anywhere on the")
    print("  page. That is a character-recognition limit, not a location failure.\n")

    if misreads:
        print("WRONG VALUES (the ones worth reading - a miss is visible, a misread is not)")
        for line in misreads:
            print(f"  {line}")

    if out_json:
        Path(out_json).write_text(json.dumps(current, indent=2))
        print(f"\nWrote {out_json}")

    print("\nWidget text renders cleanly, so this measures FIELD LOCATION and reading,")
    print("not handwriting. Handwriting needs real filled paper and no fill can fake it.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
