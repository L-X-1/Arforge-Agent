"""Build structured evidence blocks."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any


def build_evidence(source: str, content: Any, confidence: float = 1.0, metadata: dict = None) -> dict:
    if is_dataclass(content):
        content = asdict(content)
    return {
        "source": source,
        "content": content,
        "confidence": max(0.0, min(1.0, confidence)),
        "metadata": metadata or {},
    }


def evidence_from_result(result) -> dict:
    return build_evidence(getattr(result, "capability", "unknown"), getattr(result, "content", result), 1.0, getattr(result, "metadata", {}))
