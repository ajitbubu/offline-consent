"""
End-to-end over a synthetic form: render, OCR, anchor, read ink.

These assert the properties the app depends on, not tesseract's exact output.
The one thing that must never regress is the direction of a reading: a ticked
box must not read as empty, and an empty box must not read as ticked.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app import tickbox
from app.contract import Page, TickBoxRequest
from app.engines import get_engine
from app.render import UnsupportedScan, render
from tests.conftest import LABELS, build_form


def pipeline(image: Image.Image, labels=LABELS):
    engine = get_engine()
    pages = [
        Page(page=1, width=image.width, height=image.height, tokens=engine.tokens(image))
    ]
    requests = [TickBoxRequest(index=i, text=text) for i, text in enumerate(labels)]
    return pages, tickbox.read(pages, {1: image}, requests)


def test_ocr_recovers_the_printed_text():
    pages, _ = pipeline(build_form(set()))
    words = " ".join(t.text.lower() for t in pages[0].tokens)
    assert "marketing" in words
    assert "membership" in words
    assert pages[0].tokens, "tesseract returned no tokens at all"


def test_reads_a_ticked_box_as_granted_and_the_others_as_not():
    _, results = pipeline(build_form({0}))
    by_index = {r.index: r for r in results}

    assert by_index[0].granted is True, f"ticked box read as {by_index[0]!r}"
    assert by_index[1].granted is False, f"empty box read as {by_index[1]!r}"
    assert by_index[2].granted is False, f"empty box read as {by_index[2]!r}"


@pytest.mark.parametrize("ticked", [set(), {1}, {0, 2}, {0, 1, 2}])
def test_every_combination_of_ticks_reads_back(ticked):
    _, results = pipeline(build_form(ticked))
    for result in results:
        assert result.granted is (result.index in ticked), (
            f"index {result.index}: expected {result.index in ticked}, "
            f"got {result.granted} (ink={result.ink_ratio}, anchor={result.anchor_score})"
        )


def test_survives_a_grey_scan():
    # The paper level is derived per page, so a dirty scan must not read as
    # entirely inked. This is the failure that a fixed 255 background produces.
    _, results = pipeline(build_form({2}, noise=True))
    by_index = {r.index: r for r in results}
    assert by_index[2].granted is True
    assert by_index[0].granted is False


def test_an_absent_label_is_reported_as_unknown_not_as_unticked():
    # "Not found" and "found, empty" are different answers. Collapsing them
    # would let a failed anchor silently become a recorded refusal.
    _, results = pipeline(build_form({0}), labels=["I agree to something never printed here"])
    assert results[0].granted is None
    assert results[0].confidence == 0.0


def test_confidence_is_lower_for_a_worse_anchor():
    _, good = pipeline(build_form({0}), labels=[LABELS[0]])
    _, poor = pipeline(build_form({0}), labels=["I agree to receive marketing communications today please"])
    assert good[0].anchor_score > poor[0].anchor_score


def test_renders_a_pdf_and_refuses_anything_else():
    image = build_form({0})
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PDF")
    pages = render(buffer.getvalue(), "application/pdf")
    assert len(pages) == 1
    assert pages[0][1].mode == "L"

    with pytest.raises(UnsupportedScan):
        render(b"whatever", "text/csv")


def test_page_geometry_travels_with_the_tokens():
    # A bbox is meaningless without the coordinate space it refers to, and
    # evidence_object records none - so the blob has to be self-describing.
    image = build_form(set())
    pages, _ = pipeline(image)
    assert pages[0].width == image.width
    assert pages[0].height == image.height
    for token in pages[0].tokens:
        assert 0 <= token.bbox[0] < token.bbox[2] <= pages[0].width
        assert 0 <= token.bbox[1] < token.bbox[3] <= pages[0].height
