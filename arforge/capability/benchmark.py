"""Capability benchmark helpers."""

from __future__ import annotations

from arforge.capability.enhancement_engine import run_capability_enhancement


def benchmark_capability_router(samples: list[str] = None) -> dict:
    samples = samples or ["plan a task", "remember this", "modify file safely"]
    hits = sum(1 for sample in samples if run_capability_enhancement(sample).capability_results)
    return {"samples": len(samples), "hits": hits, "hit_rate": hits / len(samples)}
