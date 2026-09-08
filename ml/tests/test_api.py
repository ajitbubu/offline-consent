"""The wire contract, exercised through the HTTP surface the app actually calls."""

from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient

from app.contract import SCHEMA_VERSION
from app.main import app
from tests.conftest import LABELS, build_form

client = TestClient(app)


def scan_bytes(ticked: set[int]) -> bytes:
    buffer = io.BytesIO()
    build_form(ticked).save(buffer, format="PNG")
    return buffer.getvalue()


def post(data: bytes, labels: list[str], content_type: str = "image/png"):
    return client.post(
        "/extract",
        files={"file": ("scan.png", data, content_type)},
        data={
            "content_type": content_type,
            "labels": json.dumps([{"index": i, "text": t} for i, t in enumerate(labels)]),
        },
    )


def test_health_reports_the_engine_it_would_use():
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["schemaVersion"] == SCHEMA_VERSION
    assert "tesseract" in body["engines"]


def test_extract_returns_self_describing_pages_and_readings():
    response = post(scan_bytes({1}), LABELS)
    assert response.status_code == 200
    body = response.json()

    assert body["engine"] == "tesseract"
    assert body["engine_version"]
    page = body["pages"][0]
    # Geometry travels with the tokens; a bbox without it means nothing.
    assert page["width"] > 0 and page["height"] > 0
    assert len(page["tokens"]) > 0

    readings = {r["index"]: r for r in body["tickboxes"]}
    assert readings[1]["granted"] is True
    assert readings[0]["granted"] is False


def test_no_labels_means_tokens_only():
    # Token capture has to work on its own: banking the corpus does not depend
    # on anyone having configured a notice version yet.
    response = post(scan_bytes(set()), [])
    assert response.status_code == 200
    body = response.json()
    assert body["tickboxes"] == []
    assert len(body["pages"][0]["tokens"]) > 0


@pytest.mark.parametrize(
    "kwargs,status",
    [
        ({"files": {"file": ("x.png", b"", "image/png")}, "data": {"content_type": "image/png"}}, 400),
        ({"files": {"file": ("x.csv", b"a,b", "text/csv")}, "data": {"content_type": "text/csv"}}, 415),
    ],
)
def test_refuses_what_it_cannot_read(kwargs, status):
    assert client.post("/extract", **kwargs).status_code == status


def test_refuses_an_unknown_engine():
    response = client.post(
        "/extract",
        files={"file": ("scan.png", scan_bytes(set()), "image/png")},
        data={"content_type": "image/png", "labels": "[]", "engine": "definitely-not-real"},
    )
    assert response.status_code == 400


def test_rejects_malformed_labels():
    response = client.post(
        "/extract",
        files={"file": ("scan.png", scan_bytes(set()), "image/png")},
        data={"content_type": "image/png", "labels": "not json"},
    )
    assert response.status_code == 400
