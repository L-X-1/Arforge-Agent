"""Enhanced pipeline facade."""

from __future__ import annotations

from arforge.capability.enhancement_flow import run_enhancement_flow


def run_enhanced_pipeline(user_input: str) -> dict:
    return run_enhancement_flow(user_input)
