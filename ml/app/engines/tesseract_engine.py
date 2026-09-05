"""
Local OCR. No scan leaves the host.

Strong on the printed parts of a form - the notice wording, the field captions -
and weak on the handwritten parts, which is most of what a filled form actually
carries. That weakness is the reason the engine seam exists; it is not a reason
to avoid banking tokens now, because the tick-box read below depends only on
locating PRINTED labels, which is exactly what this is good at.
"""

from __future__ import annotations

import functools

import pytesseract
from PIL import Image

from app.contract import Token


class TesseractEngine:
    name = "tesseract"

    @functools.cache
    def version(self) -> str:  # noqa: D102
        return str(pytesseract.get_tesseract_version())

    def tokens(self, image: Image.Image) -> list[Token]:
        data = pytesseract.image_to_data(
            image,
            output_type=pytesseract.Output.DICT,
            # PSM 6: one uniform block. A consent form is a single column of
            # label/value lines, not a magazine spread, and the default page
            # segmentation invents columns on ruled forms.
            config="--psm 6",
        )

        tokens: list[Token] = []
        for i, text in enumerate(data["text"]):
            word = text.strip()
            if not word:
                continue
            # Tesseract reports -1 for boxes it did not actually recognise.
            raw_confidence = float(data["conf"][i])
            if raw_confidence < 0:
                continue
            left, top = int(data["left"][i]), int(data["top"][i])
            width, height = int(data["width"][i]), int(data["height"][i])
            tokens.append(
                Token(
                    text=word,
                    bbox=(left, top, left + width, top + height),
                    confidence=max(0.0, min(1.0, raw_confidence / 100.0)),
                )
            )
        return tokens
