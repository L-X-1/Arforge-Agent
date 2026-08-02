"""Capability enhancement flow."""

from __future__ import annotations

from arforge.capability.enhancement_engine import run_capability_enhancement


def run_enhancement_flow(user_input: str) -> dict:
    context = run_capability_enhancement(user_input)
    return {"results": [item.__dict__ for item in context.capability_results], "evidence": context.evidence}
