"""
Cloud OCR. Scans leave the host.

Reads handwriting, which local tesseract structurally cannot: it segments
character by character and cursive has no gaps to segment on. That is the whole
reason for this file.

WHAT IT DELIBERATELY DOES NOT DO. It asks for raw OCR - text and word boxes -
and nothing else. Document AI also sells Form Parser and Custom Extractor, which
work out which value belongs to which label at roughly twenty times the per-page
price. `fields.py` already does that job from the printed wording in this
organisation's own notice catalogue, so buying it a second time would mean
paying 20x for two field mappers that sometimes disagree and no rule for
arbitrating between them. The processor id is configurable precisely so that
choice stays reversible; the default is the OCR processor.

WHAT LEAVES THE BUILDING. The page raster, and nothing else - no labels, no
purposes, no identifier. That preserves the service's contract in main.py: it
never sees an identifier it could choose between (PRD SEC-9). Sending a real
filled form to a processor makes that vendor a Data Processor under DPDP s.8(2),
which is a contract and a DPO signature, not a config change. `DOCUMENT_AI_MOCK_MODE`
exists so every other part of this system can be built and tested without that.
"""

from __future__ import annotations

import functools
import json
import os
from pathlib import Path
from typing import Any

from PIL import Image

from app.contract import Token

# Page images are uploaded, not the source PDF, so the page raster stays the ONE
# coordinate space in this system: tickbox.py and fields.py both measure pixels
# on the local image, and vendor geometry is mapped onto it rather than the other
# way round. JPEG because a lossless page costs 3-5x the bytes and the upload
# happens inside the app's 20s budget; quality lives here so it can be raised if
# measurement ever shows it costs a character.
UPLOAD_FORMAT = "JPEG"
UPLOAD_QUALITY = 85

_MOCK_FIXTURE = Path(__file__).parent.parent / "fixtures" / "documentai_page.json"


def _mock_mode() -> bool:
    return os.environ.get("DOCUMENT_AI_MOCK_MODE", "").lower() in ("1", "true", "yes")


def _processor_name() -> str:
    """Fully-qualified processor path. Never hard-coded - region and ids are the
    organisation's, and differ between the demo project and production."""
    project = os.environ["GOOGLE_CLOUD_PROJECT"]
    location = os.environ["GOOGLE_CLOUD_LOCATION"]
    processor = os.environ["DOCUMENT_AI_OCR_PROCESSOR_ID"]
    version = os.environ.get("DOCUMENT_AI_OCR_PROCESSOR_VERSION")
    base = f"projects/{project}/locations/{location}/processors/{processor}"
    # Pinning a version is what makes an accuracy number reproducible six months
    # later. Unpinned means Google may move the model under a stored measurement.
    return f"{base}/processorVersions/{version}" if version else base


def _text_for(document_text: str, layout: Any) -> str:
    """Document AI returns offsets into the document's own text, not the word.

    Segments are half-open [start, end). `start_index` is absent on the first
    segment rather than zero, which is a protobuf default, not a missing value.
    """
    anchor = getattr(layout, "text_anchor", None)
    if anchor is None:
        return ""
    parts = []
    for segment in getattr(anchor, "text_segments", []) or []:
        start = int(getattr(segment, "start_index", 0) or 0)
        end = int(getattr(segment, "end_index", 0) or 0)
        parts.append(document_text[start:end])
    return "".join(parts)


def _bbox_for(layout: Any, width: int, height: int) -> tuple[int, int, int, int] | None:
    """Vendor polygon to our raster pixels.

    Deliberately min/max over ALL vertices rather than reading corners in order.
    A bounding_poly is four points of a possibly ROTATED quadrilateral, and on
    skewed scans they do not arrive top-left-first - taking vertices[0] and
    vertices[2] as opposite corners yields an inverted or zero-area box on
    exactly the pages that are hardest to read. Token validates ordering, but a
    box that is merely WRONG passes validation, so get it right here.

    Returns None when the polygon is missing or degenerate, so the caller drops
    the token rather than handing nonsense geometry to the readers.
    """
    poly = getattr(layout, "bounding_poly", None)
    if poly is None:
        return None
    vertices = list(getattr(poly, "normalized_vertices", []) or [])
    if len(vertices) < 3:
        return None

    xs = [float(getattr(v, "x", 0.0) or 0.0) for v in vertices]
    ys = [float(getattr(v, "y", 0.0) or 0.0) for v in vertices]

    x0 = max(0, min(int(round(min(xs) * width)), width))
    x1 = max(0, min(int(round(max(xs) * width)), width))
    y0 = max(0, min(int(round(min(ys) * height)), height))
    y1 = max(0, min(int(round(max(ys) * height)), height))

    # A word occupying less than a pixel is a rounding artefact, not a word.
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def _tokens_from_document(document: Any, width: int, height: int) -> list[Token]:
    """One page's worth. Word-level, because that is what the Engine seam promises
    and what fields.py and tickbox.py both index over."""
    text = getattr(document, "text", "") or ""
    tokens: list[Token] = []
    for page in getattr(document, "pages", []) or []:
        for token in getattr(page, "tokens", []) or []:
            layout = getattr(token, "layout", None)
            if layout is None:
                continue
            word = _text_for(text, layout).strip()
            if not word:
                continue
            bbox = _bbox_for(layout, width, height)
            if bbox is None:
                continue
            confidence = float(getattr(layout, "confidence", 0.0) or 0.0)
            tokens.append(
                Token(
                    text=word,
                    bbox=bbox,
                    confidence=max(0.0, min(1.0, confidence)),
                )
            )
    return tokens


class _MockDocument:
    """Just enough of the response shape for the adapter to be exercised offline.

    THE FIXTURE IS HAND-SHAPED, NOT CAPTURED. Nobody has run this against a real
    project yet. That matters more than it looks: the adapter's only interesting
    bug is polygon-to-pixel conversion, and a fixture written from the same
    reading of the same docs as the adapter shares its blind spots - the tests
    pass and the real thing is off by a systematic offset. Vendors also
    auto-deskew, which would put normalized vertices in a CORRECTED page space
    rather than the raster space we measure ink in, and no hand-written fixture
    can reveal that.

    So: this proves the pipeline, not the geometry. Capture one real response and
    replace the fixture before trusting any accuracy number, and before believing
    a tick-box read from a box these coordinates located.
    """

    def __init__(self, payload: dict) -> None:
        self.text: str = payload.get("text", "")
        self.pages = [_MockPage(p) for p in payload.get("pages", [])]


class _MockPage:
    def __init__(self, payload: dict) -> None:
        self.tokens = [_MockToken(t) for t in payload.get("tokens", [])]


class _MockToken:
    def __init__(self, payload: dict) -> None:
        self.layout = _MockLayout(payload.get("layout", {}))


class _MockLayout:
    def __init__(self, payload: dict) -> None:
        self.confidence = payload.get("confidence", 0.0)
        self.text_anchor = _MockAnchor(payload.get("textAnchor", {}))
        self.bounding_poly = _MockPoly(payload.get("boundingPoly", {}))


class _MockAnchor:
    def __init__(self, payload: dict) -> None:
        self.text_segments = [_MockSegment(s) for s in payload.get("textSegments", [])]


class _MockSegment:
    def __init__(self, payload: dict) -> None:
        self.start_index = payload.get("startIndex", 0)
        self.end_index = payload.get("endIndex", 0)


class _MockPoly:
    def __init__(self, payload: dict) -> None:
        self.normalized_vertices = [
            _MockVertex(v) for v in payload.get("normalizedVertices", [])
        ]


class _MockVertex:
    def __init__(self, payload: dict) -> None:
        self.x = payload.get("x", 0.0)
        self.y = payload.get("y", 0.0)


# One client per process, built on first use and reused.
#
# Constructing it per request re-reads credentials on every scan, and a bad
# credential then surfaces as a slow mystery on the hundredth form instead of a
# loud failure the first time. A module-level cache is the smallest thing that
# gets the once-per-process property without a lifespan hook the tests would
# also have to run.
#
# THE REGIONAL ENDPOINT IS NOT OPTIONAL. A processor lives in a region and the
# default client talks to the global endpoint, which cannot see it - the call
# fails, or worse returns nothing, and the error does not mention regions. For
# asia-south1 the host must be asia-south1-documentai.googleapis.com.
_CLIENT = None


def _default_client():
    global _CLIENT
    if _CLIENT is None:
        from google.api_core.client_options import ClientOptions  # noqa: PLC0415
        from google.cloud import documentai  # noqa: PLC0415

        location = os.environ["GOOGLE_CLOUD_LOCATION"]
        _CLIENT = documentai.DocumentProcessorServiceClient(
            client_options=ClientOptions(
                api_endpoint=f"{location}-documentai.googleapis.com"
            )
        )
    return _CLIENT


class DocumentAIEngine:
    name = "documentai"

    def __init__(self, client: Any | None = None) -> None:
        # The client is injected rather than built here so it can be created once
        # at service startup: constructing it per request re-reads credentials on
        # every scan, and a bad credential then surfaces as a slow mystery on the
        # hundredth form instead of a loud failure at boot.
        self._client = client

    @functools.cache
    def version(self) -> str:  # noqa: D102
        # The processor VERSION is the thing that makes a measurement
        # reproducible; the SDK version is not. Report what actually read the page.
        if _mock_mode():
            return "mock"
        return os.environ.get("DOCUMENT_AI_OCR_PROCESSOR_VERSION", "unpinned")

    def tokens(self, image: Image.Image) -> list[Token]:
        if _mock_mode():
            payload = json.loads(_MOCK_FIXTURE.read_text())
            return _tokens_from_document(
                _MockDocument(payload), image.width, image.height
            )

        try:
            client = self._client or _default_client()
        except KeyError as error:
            raise RuntimeError(
                f"DocumentAIEngine needs {error} in the environment. "
                "Run `npm run check:gcp` to see what is missing, or set "
                "DOCUMENT_AI_MOCK_MODE=true for local development."
            ) from error

        # Imported here, not at module scope: mock mode must work without the
        # cloud SDK installed, so a developer with no GCP account can still run
        # the whole suite.
        from google.cloud import documentai  # noqa: PLC0415

        buffer = _encode(image)
        response = client.process_document(
            request=documentai.ProcessRequest(
                name=_processor_name(),
                raw_document=documentai.RawDocument(
                    content=buffer, mime_type="image/jpeg"
                ),
            )
        )
        return _tokens_from_document(response.document, image.width, image.height)


def _encode(image: Image.Image) -> bytes:
    import io

    buffer = io.BytesIO()
    # render() already returns greyscale; JPEG will not accept some other modes.
    image.convert("L").save(buffer, format=UPLOAD_FORMAT, quality=UPLOAD_QUALITY)
    return buffer.getvalue()


__all__ = ["DocumentAIEngine"]
