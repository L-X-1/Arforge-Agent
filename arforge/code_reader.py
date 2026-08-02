"""Safe code file reader."""

from __future__ import annotations

from pathlib import Path


def read_code_file(file_path: str, root: str | Path = ".", max_chars: int = 20000) -> str:
    base = Path(root).resolve()
    path = (base / file_path).resolve() if not Path(file_path).is_absolute() else Path(file_path).resolve()
    if base not in path.parents and path != base:
        return "Refused: path escapes project root."
    if not path.exists() or not path.is_file():
        return "File not found."
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[:max_chars]
