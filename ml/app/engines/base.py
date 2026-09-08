"""
The engine seam.

Deliberately narrow: an engine turns one page image into tokens and says what it
is. Everything else - rendering, tick-box reading, the wire contract - lives
outside, so swapping tesseract for a cloud document API is one new file and one
registry entry, and the tokens already banked stay comparable.

That seam exists because the local-versus-cloud choice is not settled. Local
keeps scans of signed consent forms inside the building; a cloud API reads
handwriting materially better but makes the vendor a Data Processor under DPDP
s.8(2). The way to decide is to run both over real forms and look at the
numbers, which needs both behind one interface.
"""

from __future__ import annotations

from typing import Protocol

from PIL import Image

from app.contract import Token


class Engine(Protocol):
    name: str

    def version(self) -> str: ...

    def tokens(self, image: Image.Image) -> list[Token]:
        """Word-level boxes in the image's own pixel space, top-left origin."""
        ...
