"""
Scan bytes to page rasters.

PDF rendering goes through PyMuPDF rather than poppler: it bundles its own
renderer, so the service has no system dependency beyond tesseract itself.
"""

from __future__ import annotations

import io

from PIL import Image

# 200 DPI is the usual floor for OCR on a filled form. Below about 150 the ink
# in a tick-box stops being separable from scan noise; above 300 the raster
# grows faster than the accuracy does.
RENDER_DPI = 200

# A page bigger than this is almost certainly a mis-scanned poster or a decompression
# bomb. Refusing beats spending a minute of CPU on it.
MAX_PIXELS = 40_000_000


class UnsupportedScan(ValueError):
    """Raised for bytes this service will not try to render."""


def render(data: bytes, content_type: str) -> list[tuple[int, Image.Image]]:
    """(page number starting at 1, greyscale image) for each page."""
    if content_type == "application/pdf":
        pages = _render_pdf(data)
    elif content_type in ("image/jpeg", "image/png"):
        pages = [(1, Image.open(io.BytesIO(data)))]
    else:
        raise UnsupportedScan(f"Cannot render {content_type}")

    out: list[tuple[int, Image.Image]] = []
    for number, image in pages:
        if image.width * image.height > MAX_PIXELS:
            raise UnsupportedScan(f"Page {number} is too large to process")
        # Greyscale throughout: both tesseract and the ink-density read want one
        # channel, and converting once here keeps them looking at the same pixels.
        out.append((number, image.convert("L")))
    return out


def _render_pdf(data: bytes) -> list[tuple[int, Image.Image]]:
    import pymupdf  # imported lazily so an image-only deployment need not load it

    pages: list[tuple[int, Image.Image]] = []
    with pymupdf.open(stream=data, filetype="pdf") as document:
        for index, page in enumerate(document, start=1):
            pixmap = page.get_pixmap(dpi=RENDER_DPI, colorspace=pymupdf.csGRAY)
            pages.append(
                (index, Image.frombytes("L", (pixmap.width, pixmap.height), pixmap.samples))
            )
    return pages
