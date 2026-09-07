"""
Choosing between two matches that read the same.

The failure these defend against is not a bad OCR read - it is a perfect one in
the wrong place. The SBI account-opening form prints "Name" as a field label
AND inside "Bank/Branch to affix rubber stamp of name and code no."; text
scoring gives both 1.00, and the wrong one won. What separates them is that one
has comb cells beside it and the other has blank margin.
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app import regions
from app.contract import Token


def _blank(w: int = 600, h: int = 60) -> Image.Image:
    return Image.new("L", (w, h), 255)


def _tok(text: str, x: int, y: int, w: int = 40, h: int = 14) -> Token:
    return Token(text=text, bbox=(x, y, x + w, y + h), confidence=0.9)


def test_comb_cells_are_found():
    image = _blank()
    draw = ImageDraw.Draw(image)
    for i in range(11):  # 10 cells
        x = 20 + i * 40
        draw.line([x, 10, x, 50], fill=0, width=2)
    region = regions.classify(image, (0, 0, 600, 60), [])
    assert region.kind == "comb"
    assert region.cells >= 8
    assert region.is_field


def test_guide_letters_inside_the_cells_do_not_make_it_text():
    # REGRESSION. SBI prints F I R S T N A M E inside the comb cells, so the
    # first version of this classifier asked "is there text?" first and threw
    # away the one field that most needed comb detection.
    image = _blank()
    draw = ImageDraw.Draw(image)
    for i in range(11):
        x = 20 + i * 40
        draw.line([x, 10, x, 50], fill=0, width=2)
    letters = [_tok(c, 24 + i * 40, 20, 10, 12) for i, c in enumerate("FIRSTNAME")]
    assert regions.classify(image, (0, 0, 600, 60), letters).kind == "comb"


def test_running_text_is_not_a_field():
    image = _blank()
    draw = ImageDraw.Draw(image)
    # Drawn as well as tokenised: tokens always come from ink on the same page,
    # and a test that supplies one without the other is testing a state the
    # pipeline cannot produce.
    for x, word in ((30, "communications"), (200, "will"), (280, "be")):
        draw.text((x, 20), word, fill=0)
    words = [_tok("communications", 30, 20), _tok("will", 200, 20), _tok("be", 280, 20)]
    region = regions.classify(image, (0, 0, 600, 60), words)
    assert region.kind == "text"
    assert not region.is_field


def test_a_single_stray_character_is_not_text():
    # A lone mark is what a scan leaves in an EMPTY box. Counting it as a word
    # would reject the box for carrying evidence that it is a box.
    image = _blank()
    draw = ImageDraw.Draw(image)
    draw.line([10, 50, 590, 50], fill=0, width=3)
    region = regions.classify(image, (0, 0, 600, 60), [_tok("x", 30, 20, 8, 10)])
    assert region.kind in ("rule", "cell")
    assert region.is_field


def test_a_ruled_blank_is_a_field():
    image = _blank()
    ImageDraw.Draw(image).line([10, 50, 590, 50], fill=0, width=3)
    assert regions.classify(image, (0, 0, 600, 60), []).is_field


def test_a_bounded_table_cell_is_a_field():
    image = _blank()
    draw = ImageDraw.Draw(image)
    draw.line([10, 5, 590, 5], fill=0, width=3)
    draw.line([10, 55, 590, 55], fill=0, width=3)
    assert regions.classify(image, (0, 0, 600, 60), []).kind == "cell"


def test_empty_margin_is_writable_but_not_evidence():
    # Blank margin and an unruled answer space are identical pixels. Treating
    # "open" as proof of a field would count every label near the page edge.
    region = regions.classify(_blank(), (0, 0, 600, 60), [])
    assert region.kind == "open"
    assert region.writable
    assert not region.is_field
