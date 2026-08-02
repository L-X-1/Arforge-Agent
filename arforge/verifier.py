"""Verification helpers."""

from __future__ import annotations

import py_compile
from pathlib import Path


def verify_python_file(path: str | Path) -> dict:
    try:
        py_compile.compile(str(path), doraise=True)
    except Exception as exc:
        return {"success": False, "error": str(exc)}
    return {"success": True, "error": ""}


def verify_text_contains(text: str, required: list[str]) -> dict:
    missing = [item for item in required if item not in text]
    return {"success": not missing, "missing": missing}
