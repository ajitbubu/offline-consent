"""
The regression that matters most: a consent nobody gave.

Found by running a real SMBC savings form through POST /extract. Six options
that were NOT ticked came back `granted=true` at confidence 1.00. Cropping the
scored region for "Housewife" showed the letters "ed" from "Self Employed" -
_locate_box returns the leftmost ink run in the search band, which on that
layout is the tail of the PREVIOUS option's label, and printed text has ink
density 0.47-0.68 against INK_THRESHOLD 0.08.

Not the known INK_THRESHOLD calibration issue: those false grants clear any sane
threshold. The region simply was not a box.

THREE UNIT TESTS AND ONE END-TO-END. The discriminator is unit-tested on
constructed pixels covering both box appearances and the glyph, and runs
everywhere. The end-to-end assertion needs the real form: a synthetic
reproduction of the whole read path was tried and abandoned, because getting the
box/label geometry wrong makes it pass for the wrong reason, which is worse than
skipping. It skips where the corpus is absent (it is gitignored), rather than
pretending to cover what it cannot.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app import tickbox
from app.contract import Page, TickBoxRequest
from app.engines import get_engine

from tests.conftest import _font

FORM = Path(__file__).parent.parent.parent / (
    "docs/training-data/hand-written/FILLED_Account_Opening_Savings_Form.pdf"
)

TICKED = ["Individual", "Male", "Indian", "Resident", "Self Employed", "Graduate"]
UNTICKED = [
    "Retired", "Student", "Doctor", "Female", "Third Gender", "Non-Resident",
    "Foreigen", "HUF", "Trust", "Post Graduate", "Professional", "Real estate",
    "Housewife",
]


def _tight_ink_bbox(image: Image.Image, background: float) -> tuple[int, int, int, int]:
    """What _locate_box returns: the bounding box of the ink, not of the canvas.

    Measured rather than guessed - a hand-picked box that includes white margin
    has a clean perimeter and passes the check for the wrong reason. That mistake
    is what made the first version of this test fail.
    """
    mask = tickbox._ink_mask(image, (0, 0, image.width, image.height), background)
    ys, xs = np.nonzero(mask)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def test_printed_glyphs_are_not_boxes() -> None:
    """The discriminator, on the two signals measured from the real corpus.

    Real tick-boxes: aspect 1.00-1.13, perimeter ink 0.080-0.130 - _locate_box
    returns the MARK, and a tick's diagonal strokes leave the corners white.
    Printed glyphs: aspect 1.00-2.11, perimeter ink 0.211-0.434, because a letter
    fills its own bounding box. Squareness alone is not enough: "ed" measured
    1.00 aspect and had to be rejected on perimeter.
    """
    glyphs = Image.new("L", (140, 140), color=255)
    ImageDraw.Draw(glyphs).text((20, 40), "ed", font=_font(48), fill=0)
    bg = tickbox._background(glyphs)
    assert not tickbox._looks_like_box(glyphs, _tight_ink_bbox(glyphs, bg), bg)


def test_a_drawn_box_is_a_box() -> None:
    """The guard must not buy safety by refusing to read anything.

    A fix that rejected every region would pass the test above and destroy the
    one capability that works from the first form. This is the border-captured
    case (perimeter high), which is what the synthetic corpus forms look like.
    """
    boxed = Image.new("L", (140, 140), color=255)
    draw = ImageDraw.Draw(boxed)
    draw.rectangle((40, 40, 100, 100), outline=0, width=3)
    bg = tickbox._background(boxed)
    assert tickbox._looks_like_box(boxed, _tight_ink_bbox(boxed, bg), bg)


def test_a_tick_inside_a_box_is_a_box() -> None:
    """The mark-captured case: a sparse tick whose bounding box has empty corners.

    This is what the real SMBC form produces, and it is why a single perimeter
    threshold cannot work - this region is SPARSE where a drawn border is DENSE,
    and the printed glyph sits between them.
    """
    boxed = Image.new("L", (140, 140), color=255)
    draw = ImageDraw.Draw(boxed)
    draw.line((48, 74, 64, 92), fill=0, width=5)
    draw.line((64, 92, 96, 46), fill=0, width=5)
    bg = tickbox._background(boxed)
    assert tickbox._looks_like_box(boxed, _tight_ink_bbox(boxed, bg), bg)


@pytest.mark.skipif(not FORM.exists(), reason="corpus form absent (gitignored)")
def test_no_unticked_option_is_ever_granted_on_the_real_form() -> None:
    """Six of these came back granted=true at confidence 1.00 before the fix.

    granted must be None or False, never True. None means "no box found", which
    the review screen renders differently from "found the box, it was empty" -
    collapsing them turns a failed match into a recorded refusal, and reporting
    True turns it into a recorded grant.
    """
    import pymupdf

    doc = pymupdf.open(FORM)
    image = Image.open(
        io.BytesIO(doc[0].get_pixmap(dpi=200).tobytes("png"))
    ).convert("L")
    pages = [
        Page(page=1, width=image.width, height=image.height,
             tokens=get_engine().tokens(image))
    ]
    labels = TICKED + UNTICKED
    reqs = [TickBoxRequest(index=i, text=t) for i, t in enumerate(labels)]
    results = {labels[r.index]: r for r in tickbox.read(pages, {1: image}, reqs)}

    manufactured = [
        n for n in UNTICKED
        if n in results and results[n].granted is True
    ]
    assert not manufactured, f"consent manufactured for unticked options: {manufactured}"

    # And the real ticks still read, or the fix is worthless.
    read_back = [n for n in TICKED if n in results and results[n].granted is True]
    assert len(read_back) == len(TICKED), f"lost real ticks: {set(TICKED) - set(read_back)}"
