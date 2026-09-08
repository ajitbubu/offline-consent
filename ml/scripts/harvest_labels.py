"""
Mine the real field-label vocabulary out of a corpus of blank forms.

WHY. `fields.py` anchors on the wording PRINTED beside a handwritten field, and
the app ships a guessed list of spellings: "Full name", "Name", "Mobile",
"Email". If the paper says something else the anchor never matches, the value
reads null, and from the outside that looks like "OCR is bad" rather than "we
asked for the wrong words".

A corpus of blank bank forms cannot train anything - there is nothing filled in
to learn from. What it CAN do is tell us what Indian banking paper actually
calls its fields, which is exactly the input the anchor list needs. So this
reads the printed layer of every PDF it is given and counts the label wording it
finds, ranked by how many distinct forms use it.

Blank forms are the RIGHT source for this and filled ones would be worse: the
labels are the printed furniture of the form, identical on every copy, and no
personal data has to be handled to read them.

    cd ml && uv run python scripts/harvest_labels.py ../docs/training-data
    cd ml && uv run python scripts/harvest_labels.py ../docs/training-data --json out.json
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pymupdf

# What a printed field label looks like on a form: some words, then a colon or a
# mandatory asterisk. Numbering ("1.Name*:") is normal on Indian bank forms.
_LABEL = re.compile(r"^\s*\d{0,2}\s*[.)]?\s*([A-Za-z][A-Za-z0-9 ()/&.,'\-]{1,58}?)\s*[*]?\s*:")

# Which of the app's fields a label belongs to. Ordered: the first match wins,
# so the more specific patterns are listed first.
_KINDS: list[tuple[str, re.Pattern[str]]] = [
    ("email", re.compile(r"\be-?\s?mail\b", re.I)),
    ("phone", re.compile(r"\b(mobile|phone|telephone|tel|contact\s*(no|number))\b", re.I)),
    ("date", re.compile(r"\bdate\b|\bdated\b|\bd\.?o\.?b\b", re.I)),
    ("name", re.compile(r"\bname\b", re.I)),
]

# Labels that match "name" or "date" but are not the applicant's. Without this
# the ranking fills up with "Branch Name" and "Date of Birth", and pointing the
# anchor at those would read the wrong value with full confidence.
_NOT_THE_APPLICANT = re.compile(
    r"\b(branch|bank|company|organi[sz]ation|firm|employer|father|mother|spouse|"
    r"guardian|nominee|witness|scheme|product|city|country|state|district|"
    r"village|street|place|birth|issue|expiry|maturity|opening|closing|"
    r"commencement|designation|relationship|business|user|login)\b",
    re.I,
)

_SPACE = re.compile(r"\s+")


def clean(text: str) -> str:
    return _SPACE.sub(" ", text).strip(" .:-–—")


def table_labels_in(page: pymupdf.Page) -> set[str]:
    """Field labels that live in a table cell, with no colon to give them away.

    The line-based scan below only finds labels punctuated with a colon, which
    systematically misses an entire geometry: SMBC's loan application puts
    "Name of the Enterprise/ Individual" in one table cell and leaves the next
    one empty, and nothing about that row contains a colon. Those forms
    contributed no vocabulary at all, which is why the harvested anchor list
    could not read them.

    The rule is structural rather than textual: in a row, a cell with text
    beside a cell that is EMPTY is a label and its answer space. A row where
    both cells carry text is a heading or a two-column paragraph, not a field.
    """
    found: set[str] = set()
    try:
        tables = page.find_tables().tables
    except Exception:
        return found

    for table in tables:
        try:
            rows = table.extract()
        except Exception:
            continue
        for row in rows:
            cells = [(c or "").strip() for c in row]
            if len(cells) < 2:
                continue
            for i, cell in enumerate(cells):
                if not cell or len(cell) > 70:
                    continue
                # Skip the numbering column ("1.", "2.") - it labels nothing.
                if len(cell) <= 3 and cell.rstrip(".").isdigit():
                    continue
                rest = cells[i + 1 :]
                if rest and all(c == "" for c in rest):
                    label = clean(cell.replace("\n", " "))
                    if 2 <= len(label) <= 70:
                        found.add(label)
    return found


def labels_in(page: pymupdf.Page) -> set[str]:
    """Distinct label-shaped strings on one page."""
    found: set[str] = set()
    for line in page.get_text().splitlines():
        # A line can carry several fields: "Mobile No.: ____ Email ID: ____".
        for fragment in re.split(r"\s{3,}|\t", line):
            match = _LABEL.match(fragment)
            if not match:
                continue
            label = clean(match.group(1))
            if 2 <= len(label) <= 58:
                found.add(label)
    return found


def kind_of(label: str) -> str | None:
    for kind, pattern in _KINDS:
        if pattern.search(label):
            if kind in ("name", "date") and _NOT_THE_APPLICANT.search(label):
                return None
            return kind
    return None


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    root = Path(sys.argv[1])
    if not root.exists():
        print(f"No such directory: {root}")
        return 1

    out_json = None
    if "--json" in sys.argv:
        out_json = Path(sys.argv[sys.argv.index("--json") + 1])

    pdfs = sorted(root.rglob("*.pdf"))
    if not pdfs:
        print(f"No PDFs under {root}")
        return 1

    # Counted per DOCUMENT, not per occurrence: a label repeated on nine pages of
    # one form is one form's worth of evidence, not nine.
    per_kind: dict[str, Counter[str]] = defaultdict(Counter)
    unmatched: Counter[str] = Counter()
    read = failed = 0

    for path in pdfs:
        try:
            doc = pymupdf.open(path)
        except Exception:
            failed += 1
            continue
        seen: set[str] = set()
        try:
            for index in range(doc.page_count):
                seen |= labels_in(doc[index])
                seen |= table_labels_in(doc[index])
        except Exception:
            failed += 1
            continue
        finally:
            doc.close()

        read += 1
        for label in seen:
            kind = kind_of(label)
            if kind:
                per_kind[kind][label] += 1
            else:
                unmatched[label] += 1

    print(f"\nRead {read} of {len(pdfs)} PDFs ({failed} unreadable) under {root}\n")

    suggestion: dict[str, list[str]] = {}
    for kind in ("name", "phone", "email", "date"):
        counts = per_kind[kind]
        print(f"{kind.upper()}  ({len(counts)} distinct labels)")
        if not counts:
            print("  nothing found\n")
            continue
        for label, n in counts.most_common(12):
            print(f"  {n:4d} forms   {label}")
        # Worth adding to the anchor list: used by more than one form, so it is
        # a convention rather than one bank's quirk.
        suggestion[kind] = [label for label, n in counts.most_common(40) if n >= 2]
        print()

    print("MOST COMMON LABELS NOT MATCHED TO A FIELD")
    print("(candidates for fields the app does not yet ask for)")
    for label, n in unmatched.most_common(15):
        print(f"  {n:4d} forms   {label}")

    if out_json:
        out_json.write_text(json.dumps(suggestion, indent=2, ensure_ascii=False))
        print(f"\nWrote {out_json}")

    print("\nThese are PRINTED labels harvested from blank forms. They tell you what")
    print("to anchor on. They are not training data: nothing here is filled in, so")
    print("nothing here can teach a model what a filled value looks like.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
