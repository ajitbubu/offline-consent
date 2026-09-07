"""
What sits where a value would be written.

A printed label alone does not make a field. "Mobile No" appears on the SBI
account-opening form twice: once as a real field label with comb cells beside
it, and once inside the sentence "(All communications will be sent on provided
Mobile No./Email-ID)". Both score ~1.0 against the same anchor, and text
matching cannot tell them apart - the words are identical.

What tells them apart is what comes NEXT on the page. A field is followed by
somewhere to write: an empty table cell, a ruled blank, a row of character
boxes. Prose is followed by more prose. So this module looks at the pixels in
the band beside a label and says which it is.

Three geometries, all found in the real corpus rather than imagined:

    comb   SBI account opening      | | |P|R|I|Y|A| | |     per-character cells
    cell   SMBC loan application    +--------------+        an empty table cell
    rule   SMBC "Date: ______"      ______________          a ruled blank

and two negatives:

    text   the SBI section header   ...provided Mobile No./Email-ID)
    open   nothing at all           (may be a field with no rule, or margin)

This decides only WHERE a value could be, never WHAT it says. Reading is still
OCR's job and confirming is still a human's.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
from PIL import Image

from app.contract import Token

RegionKind = Literal["comb", "cell", "rule", "open", "text"]

# Ink is anything meaningfully darker than the paper. The paper level is
# measured per band rather than assumed to be 255, so a grey or yellowed scan
# does not read as solid ink - the same rule tickbox.py uses.
INK_RATIO_OF_BACKGROUND = 0.75

# A horizontal run covering this much of the band's width is a rule, not a
# glyph. Letters are short; table borders and ruled blanks are long.
RULE_MIN_WIDTH_FRACTION = 0.55

# Comb cells are regular. Their dividers must be this consistent in spacing
# (standard deviation over mean gap) to count as a comb rather than as
# incidental vertical strokes.
COMB_MAX_SPACING_CV = 0.28
COMB_MIN_CELLS = 4


@dataclass
class Region:
    kind: RegionKind
    # Where a value would go, in page pixels. None when the band is text or
    # empty margin - there is nowhere to read.
    box: tuple[int, int, int, int] | None
    # For a comb, how many character cells were counted.
    cells: int = 0

    @property
    def writable(self) -> bool:
        """Could a value be written here at all?"""
        return self.kind in ("comb", "cell", "rule", "open")

    @property
    def is_field(self) -> bool:
        """Is this positively a field, rather than merely not-text?

        `open` is excluded on purpose. Blank margin and an unruled answer space
        look identical, so treating `open` as proof of a field would count every
        label near the edge of the page. It is writable but not evidence.
        """
        return self.kind in ("comb", "cell", "rule")


def _ink(image: Image.Image, box: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        return np.zeros((0, 0), dtype=bool)
    crop = np.asarray(image.crop((x0, y0, x1, y1)), dtype=np.float32)
    if crop.size == 0:
        return np.zeros((0, 0), dtype=bool)
    # Median is the paper: on a form most of any band is background.
    background = float(np.median(crop)) or 255.0
    return crop < background * INK_RATIO_OF_BACKGROUND


def _horizontal_runs(mask: np.ndarray, min_width: int) -> list[int]:
    """Row indices that are mostly ink across `min_width` pixels - i.e. rules."""
    if mask.size == 0:
        return []
    return [y for y in range(mask.shape[0]) if int(mask[y].sum()) >= min_width]


# How much of the band's height a column must be ink to count as a cell wall.
#
# Not 0.6, which was the first guess and found nothing. The band is positioned
# from the LABEL's box, and a label's glyph height is not the comb row's height
# - on the SBI form the two are offset enough that real cell walls covered only
# about half the band. Measured: zero columns cleared 0.6, twenty-three cleared
# 0.4. Demanding a full-height wall inside a band that was never aligned to the
# cells is asking the pixels a question about the label.
DIVIDER_MIN_HEIGHT_FRACTION = 0.45


def _vertical_dividers(mask: np.ndarray) -> list[int]:
    """Column indices that are ink down most of the band - comb cell walls."""
    if mask.size == 0:
        return []
    tall = mask.shape[0] * DIVIDER_MIN_HEIGHT_FRACTION
    cols = [x for x in range(mask.shape[1]) if int(mask[:, x].sum()) >= tall]
    # Adjacent columns are one thick line, not two dividers.
    merged: list[int] = []
    for x in cols:
        if not merged or x - merged[-1] > 2:
            merged.append(x)
    return merged


def _looks_like_comb(dividers: list[int]) -> bool:
    """Evenly spaced dividers mean character cells rather than stray strokes."""
    if len(dividers) < COMB_MIN_CELLS + 1:
        return False
    gaps = np.diff(dividers).astype(float)
    if gaps.size == 0 or gaps.mean() <= 0:
        return False
    return float(gaps.std() / gaps.mean()) <= COMB_MAX_SPACING_CV


def classify(
    image: Image.Image,
    band: tuple[int, int, int, int],
    tokens: list[Token],
) -> Region:
    """What kind of writable region, if any, occupies `band`.

    Text wins over every other reading. A band with words in it is prose or the
    next field's label, and no amount of ruling makes it somewhere to write -
    this is the test that separates the SBI form's real "Mobile No." field from
    the sentence that mentions the same words.
    """
    x0, y0, x1, y1 = band
    if x1 <= x0 or y1 <= y0:
        return Region("open", None)

    mask = _ink(image, band)
    if mask.size == 0 or not mask.any():
        # Nothing at all. Ordering matters here: an empty band cannot be text,
        # and asking the token test first would be answering a question the
        # pixels have already settled.
        return Region("open", band)

    width = mask.shape[1]

    # 1. Regular vertical dividers: a comb. Tested BEFORE text, and that order
    #    is the whole point.
    #
    #    The first version asked "is there text here?" first and called any
    #    band with words in it prose. That rejected the SBI account-opening
    #    form's name field - because SBI prints faint guide letters INSIDE the
    #    comb cells, spelling F I R S T N A M E and M I D D L E N A M E, and
    #    OCR duly reads them. The field most in need of comb detection was the
    #    one the text test threw away.
    #
    #    Structure beats content: five or more evenly spaced full-height
    #    dividers are character cells whatever is printed between them, and
    #    prose does not produce them.
    dividers = _vertical_dividers(mask)
    if _looks_like_comb(dividers):
        return Region("comb", (x0 + dividers[0], y0, x0 + dividers[-1], y1), len(dividers) - 1)

    # 2. Words in the band, and no comb around them: prose, or the next field's
    #    label. Either way not somewhere a value for THIS label goes.
    #
    #    Single characters do not count. A lone "X" or a stray mark is what a
    #    scan leaves in an empty box, and treating it as a word would reject
    #    the box for containing evidence that it is a box.
    for t in tokens:
        cx = (t.bbox[0] + t.bbox[2]) / 2
        cy = (t.bbox[1] + t.bbox[3]) / 2
        if x0 <= cx <= x1 and y0 <= cy <= y1 and len(t.text.strip()) > 1:
            return Region("text", None)

    # 3. Long horizontal runs: a table cell (border above AND below) or a
    #    ruled blank (a single line, usually near the bottom).
    rules = _horizontal_runs(mask, int(width * RULE_MIN_WIDTH_FRACTION))
    if rules:
        near_top = any(y < mask.shape[0] * 0.25 for y in rules)
        near_bottom = any(y > mask.shape[0] * 0.6 for y in rules)
        if near_top and near_bottom:
            return Region("cell", band)
        return Region("rule", band)

    # 4. Ink, but not text, not regular, not a rule. A signature, a logo, a
    #    smudge. Not somewhere we can say a value belongs.
    return Region("open", band)


__all__ = ["classify", "Region", "RegionKind"]
