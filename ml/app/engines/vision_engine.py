"""
The other cloud OCR, so the choice can be measured instead of argued.

Document AI and Cloud Vision were each chosen once for this system, on different
days, for good reasons that pointed in opposite directions. Rather than settle it
by argument, both sit behind the same seam and get scored on the same forms.

TWO REAL DIFFERENCES, found by writing both rather than by reading about them:

  1. COORDINATES. Vision returns ABSOLUTE PIXEL vertices in the space of the
     image you submitted. We submit our own raster, so the boxes are already in
     the space tickbox.py and fields.py measure ink in - no normalisation, no
     multiplication by page dimensions, and no exposure to a vendor deskewing the
     page into a corrected space we do not share. Document AI returns normalized
     vertices, which is one conversion and one assumption more.
  2. VERSION PINNING. There is none. Vision has no processor version to pin, so
     an accuracy number measured against it is NOT reproducible: Google may move
     the model underneath a stored measurement and nothing in the response would
     say so. Document AI can be pinned. If a number has to survive an audit, that
     difference decides it.

Neither is "better". (1) favours Vision, (2) favours Document AI, and only the
forms can say which matters more here.
"""

from __future__ import annotations

import functools
import json
import os
from pathlib import Path
from typing import Any

from PIL import Image

from app.contract import Token
from app.engines.documentai_engine import UPLOAD_FORMAT, UPLOAD_QUALITY, _encode

_MOCK_FIXTURE = Path(__file__).parent.parent / "fixtures" / "vision_page.json"


def _mock_mode() -> bool:
    # Deliberately the same switch as the Document AI engine. One flag means
    # "no scan leaves this machine", and a second flag would eventually be set
    # to a different value by accident.
    return os.environ.get("DOCUMENT_AI_MOCK_MODE", "").lower() in ("1", "true", "yes")


def _bbox_for(bounding_box: Any, width: int, height: int) -> tuple[int, int, int, int] | None:
    """Vertices to our raster pixels.

    Same min/max over ALL vertices as the Document AI adapter, for the same
    reason: these are four corners of a possibly rotated quadrilateral and they
    do not arrive top-left-first on skewed scans. Taking vertices[0] and [2] as
    opposite corners inverts the box on exactly the pages that are hardest to
    read, and an inverted box does not raise - it silently produces a search band
    of negative height.

    Unlike Document AI these are already absolute pixels in the submitted image,
    so there is nothing to multiply. Clamped anyway: the vendor is not obliged to
    keep a vertex inside the page, and one pixel outside is enough to make a crop
    throw much later, somewhere unrelated.
    """
    if bounding_box is None:
        return None
    vertices = list(getattr(bounding_box, "vertices", []) or [])
    if len(vertices) < 3:
        return None

    xs = [int(getattr(v, "x", 0) or 0) for v in vertices]
    ys = [int(getattr(v, "y", 0) or 0) for v in vertices]

    x0 = max(0, min(min(xs), width))
    x1 = max(0, min(max(xs), width))
    y0 = max(0, min(min(ys), height))
    y1 = max(0, min(max(ys), height))

    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def _word_text(word: Any) -> str:
    """Vision has no word string: a word IS its symbols, in order."""
    return "".join(
        str(getattr(symbol, "text", "") or "") for symbol in getattr(word, "symbols", []) or []
    )


def _tokens_from_annotation(annotation: Any, width: int, height: int) -> list[Token]:
    """page -> block -> paragraph -> word. Word level, because that is what the
    Engine seam promises and what both readers index over."""
    tokens: list[Token] = []
    for page in getattr(annotation, "pages", []) or []:
        for block in getattr(page, "blocks", []) or []:
            for paragraph in getattr(block, "paragraphs", []) or []:
                for word in getattr(paragraph, "words", []) or []:
                    text = _word_text(word).strip()
                    if not text:
                        continue
                    bbox = _bbox_for(getattr(word, "bounding_box", None), width, height)
                    if bbox is None:
                        continue
                    confidence = float(getattr(word, "confidence", 0.0) or 0.0)
                    tokens.append(
                        Token(
                            text=text,
                            bbox=bbox,
                            confidence=max(0.0, min(1.0, confidence)),
                        )
                    )
    return tokens


class _MockAnnotation:
    """Hand-shaped from the documented response, NOT captured. Same caveat as the
    Document AI fixture and for the same reason: it was written from the same
    reading of the same docs as the adapter, so it cannot catch a shared
    misreading. It proves the traversal, not the geometry."""

    def __init__(self, payload: dict) -> None:
        self.pages = [_MockPage(p) for p in payload.get("pages", [])]


class _MockPage:
    def __init__(self, payload: dict) -> None:
        self.blocks = [_MockBlock(b) for b in payload.get("blocks", [])]


class _MockBlock:
    def __init__(self, payload: dict) -> None:
        self.paragraphs = [_MockParagraph(p) for p in payload.get("paragraphs", [])]


class _MockParagraph:
    def __init__(self, payload: dict) -> None:
        self.words = [_MockWord(w) for w in payload.get("words", [])]


class _MockWord:
    def __init__(self, payload: dict) -> None:
        self.confidence = payload.get("confidence", 0.0)
        self.symbols = [_MockSymbol(s) for s in payload.get("symbols", [])]
        self.bounding_box = _MockBox(payload.get("boundingBox", {}))


class _MockSymbol:
    def __init__(self, payload: dict) -> None:
        self.text = payload.get("text", "")


class _MockBox:
    def __init__(self, payload: dict) -> None:
        self.vertices = [_MockVertex(v) for v in payload.get("vertices", [])]


class _MockVertex:
    def __init__(self, payload: dict) -> None:
        self.x = payload.get("x", 0)
        self.y = payload.get("y", 0)


# Same once-per-process reuse as the Document AI engine. Vision needs no
# regional endpoint: it has no processor to be scoped to, which is one of the
# two real differences between the two engines.
_CLIENT = None


def _default_client():
    global _CLIENT
    if _CLIENT is None:
        from google.cloud import vision  # noqa: PLC0415

        _CLIENT = vision.ImageAnnotatorClient()
    return _CLIENT


class VisionEngine:
    name = "vision"

    def __init__(self, client: Any | None = None) -> None:
        # Injected, not built here - same reason as the Document AI engine: a
        # client built per request re-reads credentials on every scan, and a bad
        # credential then surfaces as a slow mystery rather than a loud failure.
        self._client = client

    @functools.cache
    def version(self) -> str:  # noqa: D102
        if _mock_mode():
            return "mock"
        # Honest about the limitation rather than inventing a version string.
        # Vision exposes no model version, so a measurement taken against it
        # cannot be reproduced after Google moves the model.
        return "images:annotate/v1 (unpinnable)"

    def tokens(self, image: Image.Image) -> list[Token]:
        if _mock_mode():
            payload = json.loads(_MOCK_FIXTURE.read_text())
            return _tokens_from_annotation(
                _MockAnnotation(payload), image.width, image.height
            )

        client = self._client or _default_client()

        # Imported here so mock mode works without the cloud SDK installed.
        from google.cloud import vision  # noqa: PLC0415

        response = client.document_text_detection(
            image=vision.Image(content=_encode(image))
        )
        # Vision reports failure in the body with HTTP 200. Unchecked, an error
        # response reads as a page with no words - indistinguishable from a blank
        # scan, which is the one failure that must never look like success.
        if getattr(response, "error", None) and getattr(response.error, "message", ""):
            raise RuntimeError(f"Cloud Vision: {response.error.message}")

        return _tokens_from_annotation(
            response.full_text_annotation, image.width, image.height
        )


__all__ = ["VisionEngine", "UPLOAD_FORMAT", "UPLOAD_QUALITY"]
