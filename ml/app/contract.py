"""
The wire contract between the Next.js app and this service.

Two rules shape it, and both come from the app rather than from convenience:

1.  **The service never sees a database identifier.** SEC-9 in the PRD says the
    extraction model never chooses one. The app sends tick-box labels as an
    ordered list and gets results back by `index`; mapping an index onto a
    purpose id is the app's job, on the app's side, against its own catalogue.

2.  **Token output is self-describing.** Page dimensions travel with the tokens
    that use them. A bounding box is meaningless without the coordinate space it
    refers to, and `evidence_object` records no geometry - so rather than adding
    speculative columns there, the blob carries what it needs. That also makes a
    stored blob still readable years later when the renderer's default DPI has
    moved on.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

SCHEMA_VERSION = 1


class Token(BaseModel):
    """One recognised word, in the page's own pixel space."""

    text: str
    # [x0, y0, x1, y1], origin top-left, pixels in this page's raster.
    bbox: tuple[int, int, int, int]
    # 0.0-1.0. Tesseract reports -1 for whitespace boxes; those are dropped.
    confidence: float = Field(ge=0.0, le=1.0)


class Page(BaseModel):
    page: int = Field(ge=1)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    tokens: list[Token]


class TickBoxRequest(BaseModel):
    """One printed label to look for, identified only by its position."""

    index: int = Field(ge=0)
    text: str


class TickBoxResult(BaseModel):
    index: int
    # None when the printed label could not be located on the page at all, which
    # is different from "found the box and it is empty".
    granted: bool | None
    confidence: float = Field(ge=0.0, le=1.0)
    page: int | None = None
    bbox: tuple[int, int, int, int] | None = None
    # How well the printed label matched the token stream, 0.0-1.0. A low anchor
    # score means the reading below it is not worth much whatever the ink says.
    anchor_score: float = Field(ge=0.0, le=1.0)
    ink_ratio: float | None = None


class ExtractResponse(BaseModel):
    schema_version: int = SCHEMA_VERSION
    engine: str
    engine_version: str
    pages: list[Page]
    tickboxes: list[TickBoxResult]
