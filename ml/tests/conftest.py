"""A synthetic consent form, so the pipeline can be tested without a real scan."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

LABELS = [
    "I agree to receive marketing communications",
    "I agree to my data being shared with partners",
    "I agree to participate in customer research",
]

# A real TTF is needed: PIL's built-in bitmap font renders too small for OCR.
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    pytest.skip("no scalable font available to render a test form")


def build_form(ticked: set[int], *, noise: bool = False) -> Image.Image:
    """A form at roughly 200 DPI with `ticked` boxes marked."""
    width, height = 1700, 2200
    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)

    draw.text((140, 130), "MEMBERSHIP APPLICATION FORM", font=_font(46), fill=0)
    draw.text((140, 230), "Full name:  Priya Sharma", font=_font(36), fill=0)
    draw.text((140, 300), "Mobile:     98765 43210", font=_font(36), fill=0)
    draw.text((140, 370), "Email:      priya.sharma@example.org", font=_font(36), fill=0)

    box_size, left = 46, 150
    for index, label in enumerate(LABELS):
        y = 460 + index * 130
        draw.rectangle([left, y, left + box_size, y + box_size], outline=0, width=3)
        if index in ticked:
            # A cross drawn corner to corner, as a person would.
            draw.line([left + 8, y + 8, left + box_size - 8, y + box_size - 8], fill=0, width=6)
            draw.line([left + box_size - 8, y + 8, left + 8, y + box_size - 8], fill=0, width=6)
        draw.text((left + box_size + 34, y + 4), label, font=_font(34), fill=0)

    draw.text((140, 950), "Signed:  4 March 2019", font=_font(36), fill=0)

    if noise:
        # A grey, slightly dirty scan: the paper is no longer 255.
        image = image.point(lambda v: int(v * 0.86) + 18)

    return image


@pytest.fixture
def form_ticked_first() -> Image.Image:
    return build_form({0})
