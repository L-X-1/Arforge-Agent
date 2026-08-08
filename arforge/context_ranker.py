"""Legacy snippet ranking helper; it does not allocate provider context."""

from __future__ import annotations


def rank_context_items(query: str, items: list[dict], limit: int = 10) -> list[dict]:
    tokens = [token.lower() for token in query.split() if token.strip()]
    scored = []
    for item in items:
        text = str(item).lower()
        score = sum(1 for token in tokens if token in text)
        scored.append(item | {"score": score})
    return sorted(scored, key=lambda item: item["score"], reverse=True)[:limit]
