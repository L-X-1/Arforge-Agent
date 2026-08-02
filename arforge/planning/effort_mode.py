"""Effort mode detection."""

from __future__ import annotations


def detect_effort_mode(user_input: str) -> str:
    text = user_input.lower()
    if any(word in text for word in ["仔细", "详细", "deep", "thorough"]):
        return "high"
    if any(word in text for word in ["简单", "quick", "brief"]):
        return "low"
    return "medium"


def get_effort_config(mode: str):
    return {
        "low": {"max_steps": 3, "detail": "brief"},
        "medium": {"max_steps": 5, "detail": "normal"},
        "high": {"max_steps": 8, "detail": "detailed"},
    }.get(mode, {"max_steps": 5, "detail": "normal"})
