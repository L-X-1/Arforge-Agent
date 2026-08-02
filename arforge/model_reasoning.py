"""Model reasoning helpers."""

from __future__ import annotations

import json
import re


def extract_json(text: str):
    match = re.search(r"\{.*\}|\[.*\]", text, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def summarize_reasoning(text: str, max_chars: int = 500):
    return text.strip()[:max_chars]
