"""Response mode helpers."""

from __future__ import annotations


def detect_response_mode(user_input: str) -> str:
    text = user_input.lower()
    if "json" in text:
        return "json"
    if "表格" in text or "table" in text:
        return "table"
    return "text"
