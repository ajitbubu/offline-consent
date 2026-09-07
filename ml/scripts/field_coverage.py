"""
How much of a real form can extraction actually locate?

WHY THIS AND NOT ACCURACY. The corpus in docs/training-data is 146 BLANK bank
templates, so there is no filled value to check a read against - measuring
"accuracy" over them would be measuring nothing. What a blank form does answer,
and answers well, is the precondition: can the anchor FIND the field at all?
A label that cannot be located is a field that can never be read, whatever the
handwriting looks like. That number moves when the extractor gets better and it
is honest on blank paper.

Reported per field and per bank, so a regression shows up as "HDFC name dropped
from 6 forms to 2" rather than as a single number nobody can act on.

    cd ml && uv run python scripts/field_coverage.py ../docs/training-data
    cd ml && uv run python scripts/field_coverage.py ../docs/training-data --json baseline.json
    cd ml && uv run python scripts/field_coverage.py ../docs/training-data --against baseline.json
"""

from __future__ import annotations

import io
import json
import sys
from collections import defaultdict
from pathlib import Path

import pymupdf
from PIL import Image

# Run as a script from ml/, so the package root is not on the path by default.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import fields as fields_reader
from app.contract import FieldRequest, Page
from app.engines import get_engine

# The same requests the app sends, kept in step with FIELD_REQUESTS in
# src/lib/extraction.ts. If those drift, this measures the wrong thing.
REQUESTS = [
    FieldRequest(
        key="fullName",
        kind="text",
        labels=[
            "Name of Applicant",
            "Name of Primary Depositor",
            "Applicant name",
            "Full name",
            "Name (Same as ID Proof)",
            "Member name",
            "Name",
        ],
    ),
    FieldRequest(
        key="phone",
        kind="phone",
        labels=["Mobile No", "Mobile number", "Mobile", "Phone", "Telephone", "Contact number", "Tel"],
    ),
    FieldRequest(key="email", kind="email", labels=["Email ID", "E-mail ID", "Email address", "Email", "E-mail"]),
    FieldRequest(key="collectedOn", kind="date", labels=["Date (DD/MM/YYYY)", "Date signed", "Signed", "Dated", "Date"]),
]

# Only the first pages: a field a person fills is on the front of the form, and
# OCR over 1231 pages costs minutes per run for pages that carry terms and
# conditions. Raised with --pages if a bank buries its fields deeper.
DEFAULT_PAGES = 2
DPI = 200


def pages_of(path: Path, limit: int) -> list[Page]:
    engine = get_engine()
    out: list[Page] = []
    doc = pymupdf.open(path)
    try:
        for index in range(min(limit, doc.page_count)):
            pix = doc[index].get_pixmap(dpi=DPI)
            image = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
            out.append(
                Page(page=index + 1, width=image.width, height=image.height, tokens=engine.tokens(image))
            )
    finally:
        doc.close()
    return out


def _anchor_is_labelled(page: Page, box: tuple[int, int, int, int]) -> bool:
    """Is the matched text punctuated like a printed field label?

    Reuses fields._label_bonus rather than restating its rule: the tokens that
    end the anchor are found by position, and the bonus says whether what
    follows is a colon or a mandatory asterisk.
    """
    ordered = sorted(range(len(page.tokens)), key=lambda i: (page.tokens[i].bbox[1], page.tokens[i].bbox[0]))
    for i in ordered:
        t = page.tokens[i]
        # The last token of the anchor is the one whose right edge is the box's.
        if abs(t.bbox[2] - box[2]) <= 2 and abs(t.bbox[3] - box[3]) <= 4:
            return fields_reader._label_bonus(page.tokens, i + 1) > 0
    return False


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    root = Path(sys.argv[1])
    if not root.exists():
        print(f"No such directory: {root}")
        return 1

    def flag(name: str, default=None):
        return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

    page_limit = int(flag("--pages", DEFAULT_PAGES))
    out_json = flag("--json")
    against = flag("--against")
    only = flag("--only")

    pdfs = sorted(root.rglob("*.pdf"))
    if only:
        pdfs = [p for p in pdfs if only.lower() in str(p).lower()]
    if not pdfs:
        print(f"No PDFs under {root}")
        return 1

    print(f"\nReading {len(pdfs)} forms at {DPI} DPI, first {page_limit} page(s) each.")
    print("Locating a field means the printed label was found; it does not mean a")
    print("value was read, because these forms are blank.\n")

    # Two numbers, because the loose one flatters.
    #
    # "located" only asks whether SOMETHING scored above MIN_ANCHOR_SCORE, and a
    # fuzzy match against any sentence containing "Name" or "Date" clears that
    # bar - the SBI form's section header "...sent on provided Mobile No./
    # Email-ID)" matched at 1.00 and is prose, not a field. A metric that counts
    # that as success sits at ~98% on day one and can never show an improvement,
    # which makes it useless as the thing a loop optimises.
    #
    # "labelled" is the honest one: the anchor landed on text punctuated like a
    # printed field label (a colon, or the asterisk Indian bank forms use for
    # mandatory). That is the population a value can actually be read beside.
    located: dict[str, int] = defaultdict(int)
    labelled: dict[str, int] = defaultdict(int)
    per_bank: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    bank_totals: dict[str, int] = defaultdict(int)
    failures: dict[str, list[str]] = defaultdict(list)
    read_ok = 0

    for path in pdfs:
        bank = path.parent.name if path.parent != root else "root"
        bank_totals[bank] += 1
        try:
            pages = pages_of(path, page_limit)
        except Exception as error:  # a corrupt or encrypted PDF is data, not a crash
            failures["unreadable"].append(f"{path.name}: {error}")
            continue
        read_ok += 1

        for result in fields_reader.read(pages, REQUESTS):
            if result.anchor_score < fields_reader.MIN_ANCHOR_SCORE:
                failures[result.key].append(path.name)
                continue
            located[result.key] += 1

            # Did the anchor land on a punctuated label, or inside a sentence?
            page = next((p for p in pages if p.page == result.page), None)
            if page is not None and result.bbox is not None:
                if _anchor_is_labelled(page, result.bbox):
                    labelled[result.key] += 1
                    per_bank[bank][result.key] += 1

        sys.stdout.write(".")
        sys.stdout.flush()

    print(f"\n\nRead {read_ok} of {len(pdfs)} forms.\n")

    print(f"  {'field':<12} {'matched':>9}  {'ON A LABEL':>11}  (a match in prose is not a field)")
    current: dict[str, float] = {}
    for request in REQUESTS:
        loose = located[request.key]
        tight = labelled[request.key]
        pct = (tight / read_ok * 100) if read_ok else 0.0
        loose_pct = (loose / read_ok * 100) if read_ok else 0.0
        current[request.key] = round(pct, 1)
        bar = "#" * int(pct / 4)
        print(f"  {request.key:<12} {loose_pct:8.1f}%  {pct:10.1f}%  {bar}")

    overall = round(sum(current.values()) / len(current), 1) if current else 0.0
    current["_overall"] = overall
    print(f"\n  overall      {overall:5.1f}%\n")

    print("BY BANK")
    print(f"  {'bank':<10} {'forms':>5}  " + "  ".join(f"{r.key[:9]:>9}" for r in REQUESTS))
    for bank in sorted(bank_totals):
        cells = "  ".join(f"{per_bank[bank][r.key]:>9d}" for r in REQUESTS)
        print(f"  {bank:<10} {bank_totals[bank]:>5d}  {cells}")

    if against:
        try:
            base = json.loads(Path(against).read_text())
            print(f"\nAGAINST {against}")
            for key in [r.key for r in REQUESTS] + ["_overall"]:
                was, now = base.get(key, 0.0), current.get(key, 0.0)
                delta = round(now - was, 1)
                mark = "  " if abs(delta) < 0.05 else ("UP" if delta > 0 else "DOWN")
                print(f"  {key:<12} {was:5.1f}% -> {now:5.1f}%  {delta:+5.1f}  {mark}")
        except Exception as error:
            print(f"\nCould not read {against}: {error}")

    if out_json:
        Path(out_json).write_text(json.dumps(current, indent=2))
        print(f"\nWrote {out_json}")

    if failures["unreadable"]:
        print(f"\nUNREADABLE ({len(failures['unreadable'])})")
        for line in failures["unreadable"][:5]:
            print(f"  {line}")

    print("\nA located field is not a read field. These forms carry no values;")
    print("this measures whether extraction could find them if they did.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
