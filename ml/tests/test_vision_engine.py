"""
The Cloud Vision adapter, offline, and the ways it differs from Document AI.

Same caveat as the Document AI tests: the fixture is hand-shaped, so these prove
the traversal and the guards, not the geometry. One captured response upgrades
them.
"""

from __future__ import annotations

import pytest
from PIL import Image

from app.engines import available, get_engine
from app.engines.vision_engine import VisionEngine

PAGE_W, PAGE_H = 1700, 2200


@pytest.fixture
def mock_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DOCUMENT_AI_MOCK_MODE", "true")


@pytest.fixture
def page() -> Image.Image:
    return Image.new("L", (PAGE_W, PAGE_H), color=255)


def test_registry_exposes_all_three_engines() -> None:
    assert available() == ["documentai", "tesseract", "vision"]
    assert isinstance(get_engine("vision"), VisionEngine)


def test_walks_page_block_paragraph_word(mock_mode: None, page: Image.Image) -> None:
    # Vision has no word string: a word IS its symbols, joined in order.
    tokens = VisionEngine().tokens(page)
    assert [t.text for t in tokens] == ["Full", "name:", "PRIYA", "SHARMA"]


def test_vertices_are_absolute_pixels_not_normalised(
    mock_mode: None, page: Image.Image
) -> None:
    """The difference that matters most between the two cloud engines.

    Document AI hands back 0..1 normalized vertices that must be multiplied by
    page dimensions - one conversion, and one assumption about WHICH page space
    they refer to. Vision hands back pixels in the image we submitted, which is
    already the raster tickbox.py measures ink in. Nothing to convert means
    nothing to get wrong.
    """
    full = next(t for t in VisionEngine().tokens(page) if t.text == "Full")
    # Straight through from the fixture, unscaled.
    assert full.bbox == (136, 220, 272, 286)


def test_a_rotated_word_still_yields_an_ordered_box(
    mock_mode: None, page: Image.Image
) -> None:
    priya = next(t for t in VisionEngine().tokens(page) if t.text == "PRIYA")
    x0, y0, x1, y1 = priya.bbox
    assert x1 > x0 and y1 > y0
    assert (x0, x1) == (476, 714)


def test_degenerate_and_whitespace_words_are_dropped(
    mock_mode: None, page: Image.Image
) -> None:
    texts = [t.text for t in VisionEngine().tokens(page)]
    assert "Date" not in texts          # zero-area box
    assert all(t.strip() for t in texts)  # whitespace-only symbols


def test_version_admits_it_cannot_be_pinned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Vision exposes no model version. Saying so is the point.

    An accuracy number measured against an unpinnable model is not reproducible:
    Google may move the model and nothing in the response would say so. Document
    AI can be pinned. If a stored measurement has to survive an audit, that
    difference decides which engine to use.
    """
    monkeypatch.delenv("DOCUMENT_AI_MOCK_MODE", raising=False)
    assert "unpinnable" in VisionEngine().version()


def test_an_injected_client_is_still_honoured(
    monkeypatch: pytest.MonkeyPatch, page: Image.Image
) -> None:
    """The engine now builds its own client, but injection must still win.

    Vision needs no project or region - it runs on ambient credentials - so
    unlike the Document AI engine there is no config to be missing and nothing
    to assert about a helpful error. What matters is that the seam survives:
    tests and a startup hook must both be able to hand it a client.
    """
    monkeypatch.delenv("DOCUMENT_AI_MOCK_MODE", raising=False)

    class _Empty:
        error = None
        full_text_annotation = None

    class _Client:
        calls = 0
        def document_text_detection(self, image: object) -> _Empty:  # noqa: ARG002
            _Client.calls += 1
            return _Empty()

    client = _Client()
    assert VisionEngine(client=client).tokens(page) == []
    assert _Client.calls == 1, "injected client was bypassed"


def test_an_error_body_is_not_read_as_a_blank_page(
    monkeypatch: pytest.MonkeyPatch, page: Image.Image
) -> None:
    """Vision reports failure in the body with HTTP 200.

    Unchecked, an error response walks to zero words - indistinguishable from a
    genuinely blank scan. That is the one failure that must never look like
    success, because a blank read is a form the reviewer types by hand while a
    silent quota error is a system that has stopped working.
    """
    monkeypatch.delenv("DOCUMENT_AI_MOCK_MODE", raising=False)

    class _Error:
        message = "RESOURCE_EXHAUSTED: quota exceeded"

    class _Response:
        error = _Error()
        full_text_annotation = None

    class _Client:
        def document_text_detection(self, image: object) -> _Response:  # noqa: ARG002
            return _Response()

    with pytest.raises(RuntimeError, match="quota exceeded"):
        VisionEngine(client=_Client()).tokens(page)
