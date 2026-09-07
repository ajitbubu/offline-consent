"""
Extraction service for scanned consent forms.

Stateless and domain-free by design: it holds no database connection, knows
nothing about purposes or people, and never sees an identifier it could choose
between. It takes bytes and a list of printed labels, and returns tokens and
readings. The app decides what any of it means.

If this service is down or slow, the app must carry on without it - a draft that
is not pre-filled is just the manual entry form, which is the same screen.
`intake_draft` has no 'extracting' state for exactly that reason.
"""

from __future__ import annotations

import json
import logging

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from app import fields as fields_reader
from app import tickbox
from app.contract import (
    SCHEMA_VERSION,
    ExtractResponse,
    FieldRequest,
    Page,
    TickBoxRequest,
)
from app.engines import DEFAULT_ENGINE, available, get_engine
from app.render import UnsupportedScan, render

logger = logging.getLogger(__name__)

# Matches MAX_EVIDENCE_BYTES in src/lib/evidence.ts. The app will not store a
# scan larger than this, so there is no point accepting one here.
MAX_BYTES = 15 * 1024 * 1024

app = FastAPI(title="offline-consent extraction", version="0.1.0")


@app.get("/health")
def health() -> dict[str, object]:
    engine = get_engine()
    return {
        "ok": True,
        "schemaVersion": SCHEMA_VERSION,
        "engines": available(),
        "default": DEFAULT_ENGINE,
        "engineVersion": engine.version(),
        # Served so tooling never has to restate them. scripts/calibrate-tickbox.mjs
        # carried its own copy of INK_THRESHOLD and, in the same breath, told the
        # operator to go and edit tickbox.py - so the first successful use of the
        # calibrator made the calibrator wrong, and it then reported misread
        # counts against a threshold no longer in force. A number a tool exists
        # to change is the last number that tool should hard-code.
        "inkThreshold": tickbox.INK_THRESHOLD,
        "minAnchorScore": tickbox.MIN_ANCHOR_SCORE,
    }


@app.post("/extract", response_model=ExtractResponse)
async def extract(
    file: UploadFile = File(...),
    content_type: str = Form(...),
    # JSON array of {"index": int, "text": str}. Never a database identifier:
    # results come back by index and the app maps them onto its own catalogue.
    labels: str = Form("[]"),
    # JSON array of {"key": str, "labels": [str], "kind": str}. The printed
    # wording beside each handwritten field, so the value next to it can be
    # read. Same rule as tick-box labels: wording, never an identifier.
    fields: str = Form("[]"),
    engine: str | None = Form(None),
) -> ExtractResponse:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File is too large")

    try:
        requests = [TickBoxRequest(**item) for item in json.loads(labels)]
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=400, detail=f"Bad labels: {error}") from error

    try:
        field_requests = [FieldRequest(**item) for item in json.loads(fields)]
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=400, detail=f"Bad fields: {error}") from error

    try:
        selected = get_engine(engine)
    except KeyError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    try:
        rendered = render(data, content_type)
    except UnsupportedScan as error:
        raise HTTPException(status_code=415, detail=str(error)) from error

    pages: list[Page] = []
    images = {}
    for number, image in rendered:
        images[number] = image
        pages.append(
            Page(
                page=number,
                width=image.width,
                height=image.height,
                tokens=selected.tokens(image),
            )
        )

    readings = tickbox.read(pages, images, requests) if requests else []
    # Images, not just tokens: choosing between two identical text matches
    # needs to see whether there are comb cells or an empty table cell beside
    # each - the SBI form says "Name" in a field label and in "affix rubber
    # stamp of name and code no.", and only the pixels separate them.
    field_readings = (
        fields_reader.read(pages, field_requests, images) if field_requests else []
    )

    return ExtractResponse(
        engine=selected.name,
        engine_version=selected.version(),
        pages=pages,
        tickboxes=readings,
        fields=field_readings,
    )
