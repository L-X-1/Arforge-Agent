"""Fuse evidence into answer context."""

from __future__ import annotations


def fuse_evidence(evidence: list[dict], max_items: int = 8) -> dict:
    ranked = sorted(evidence, key=lambda item: item.get("confidence", 0), reverse=True)[:max_items]
    summary = "\n".join(f"- {item.get('source')}: {item.get('content')}" for item in ranked)
    return {"items": ranked, "summary": summary}


def format_evidence_summary(evidence: list[dict]) -> str:
    return fuse_evidence(evidence)["summary"]
