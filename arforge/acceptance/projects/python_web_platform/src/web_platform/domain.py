from __future__ import annotations


def normalize_title(title: object) -> str:
    normalized = str(title or "").strip()
    if not normalized:
        raise ValueError("title is required")
    return normalized
