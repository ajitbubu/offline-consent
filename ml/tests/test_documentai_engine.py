"""
The adapter, offline.

WHAT THESE TESTS CAN AND CANNOT PROVE. They prove the pipeline: that a vendor
response shape becomes Tokens this system can read, that rubbish is dropped
rather than passed on, and that a missing client fails loudly. They do NOT prove
the geometry is right - the fixture was hand-shaped from the docs by the same
reasoning as the adapter, so both share any misreading. One captured real
response replaces the fixture and turns these into real tests.
"""

from __future__ import annotations

import os

import pytest
from PIL import Image

from app.engines import available, get_engine
from app.engines.documentai_engine import DocumentAIEngine

PAGE_W, PAGE_H = 1700, 2200


@pytest.fixture
def mock_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DOCUMENT_AI_MOCK_MODE", "true")


@pytest.fixture
def page() -> Image.Image:
    return Image.new("L", (PAGE_W, PAGE_H), color=255)


def test_registry_exposes_the_engine() -> None:
    assert "documentai" in available()
    assert isinstance(get_engine("documentai"), DocumentAIEngine)


def test_mock_mode_reads_without_a_client(mock_mode: None, page: Image.Image) -> None:
    # The point of mock mode: no GCP account, no credentials, no network.
    tokens = DocumentAIEngine().tokens(page)
    assert [t.text for t in tokens] == ["Full", "name:", "PRIYA", "SHARMA"]


def test_a_rotated_polygon_still_yields_an_ordered_box(
    mock_mode: None, page: Image.Image
) -> None:
    """The fixture's "PRIYA" token has vertices that do NOT start top-left.

    Reading vertices[0] and vertices[2] as opposite corners inverts it. This is
    the failure that would not raise: an inverted box passes straight into
    fields.py's height maths and tickbox.py's search bands as silent nonsense.
    """
    priya = next(t for t in DocumentAIEngine().tokens(page) if t.text == "PRIYA")
    x0, y0, x1, y1 = priya.bbox
    assert x1 > x0 and y1 > y0
    # 0.28-0.42 of the page width, whichever order the vertices arrived in.
    assert x0 == round(0.28 * PAGE_W)
    assert x1 == round(0.42 * PAGE_W)


def test_degenerate_and_empty_tokens_are_dropped(
    mock_mode: None, page: Image.Image
) -> None:
    texts = [t.text for t in DocumentAIEngine().tokens(page)]
    # A sub-pixel polygon is a rounding artefact; a whitespace-only anchor is not
    # a word. Neither should reach a reader as a zero-area box or an empty string.
    assert "Date" not in texts
    assert all(t.strip() for t in texts)


def test_confidence_survives_the_wire_in_range(
    mock_mode: None, page: Image.Image
) -> None:
    tokens = DocumentAIEngine().tokens(page)
    assert all(0.0 <= t.confidence <= 1.0 for t in tokens)
    # Handwriting reads lower than print, and that gap is the signal the
    # pre-fill gate depends on. If it ever inverts, the gate is meaningless.
    printed = next(t for t in tokens if t.text == "Full").confidence
    handwritten = next(t for t in tokens if t.text == "SHARMA").confidence
    assert handwritten < printed


def test_version_reports_the_processor_not_the_sdk(mock_mode: None) -> None:
    # A measurement is reproducible against a processor VERSION. The SDK version
    # says nothing about what read the page.
    assert DocumentAIEngine().version() == "mock"


def test_missing_config_names_what_is_missing(
    monkeypatch: pytest.MonkeyPatch, page: Image.Image
) -> None:
    """Outside mock mode the engine builds its own client - but only if it can.

    The engine used to demand an injected client and raise if it had none, which
    made it unusable from a script. It now builds one per process. The property
    worth keeping is not "refuses without a client" but "says which variable is
    missing": a processor path assembled from half-set environment variables
    fails somewhere inside Google's SDK, with an error that never mentions the
    variable you forgot.
    """
    monkeypatch.delenv("DOCUMENT_AI_MOCK_MODE", raising=False)
    for var in ("GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"):
        monkeypatch.delenv(var, raising=False)
    # Whichever is read first, the message must NAME it. Asserting one specific
    # variable would bind the test to the order the client happens to read them.
    with pytest.raises(RuntimeError, match="GOOGLE_CLOUD_"):
        DocumentAIEngine().tokens(page)


def test_mock_mode_is_off_unless_explicitly_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A truthy-looking value must not switch a production service to fixtures."""
    monkeypatch.setenv("DOCUMENT_AI_MOCK_MODE", "false")
    for var in ("GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"):
        monkeypatch.delenv(var, raising=False)
    assert os.environ["DOCUMENT_AI_MOCK_MODE"] == "false"
    # "false" must take the REAL path, not the fixture path. With config absent
    # that path raises - which is the proof it was taken.
    with pytest.raises(RuntimeError, match="GOOGLE_CLOUD_"):
        DocumentAIEngine().tokens(Image.new("L", (10, 10)))
