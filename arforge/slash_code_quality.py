"""Code quality slash helpers."""

from __future__ import annotations

from arforge.verifier_v2 import verify_files


def verify_python_paths(text: str) -> str:
    paths = [part for part in text.split() if part.endswith(".py")]
    return str(verify_files(paths))
