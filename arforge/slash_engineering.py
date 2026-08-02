"""Engineering slash helpers."""

from __future__ import annotations

from arforge.capability.enhancement_engine import run_capability_enhancement


def capability_status(query: str = "") -> str:
    context = run_capability_enhancement(query or "plan")
    return "\n".join(result.capability for result in context.capability_results)
