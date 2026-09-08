"""Engine registry. Add a cloud adapter here; nothing else needs to know."""

from __future__ import annotations

from app.engines.base import Engine
from app.engines.documentai_engine import DocumentAIEngine
from app.engines.tesseract_engine import TesseractEngine
from app.engines.vision_engine import VisionEngine

_ENGINES: dict[str, type] = {
    TesseractEngine.name: TesseractEngine,
    DocumentAIEngine.name: DocumentAIEngine,
    VisionEngine.name: VisionEngine,
}

DEFAULT_ENGINE = TesseractEngine.name


def get_engine(name: str | None = None) -> Engine:
    key = name or DEFAULT_ENGINE
    if key not in _ENGINES:
        raise KeyError(f"Unknown engine {key!r}. Available: {sorted(_ENGINES)}")
    return _ENGINES[key]()


def available() -> list[str]:
    return sorted(_ENGINES)


__all__ = ["Engine", "get_engine", "available", "DEFAULT_ENGINE"]
