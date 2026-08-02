"""Directory metadata helpers."""

from __future__ import annotations

from pathlib import Path


def build_directory_metadata(root: str = "arforge") -> dict:
    return {"success": True, "items": len(list_directory_metadata(root))}


def list_directory_metadata(root: str = "arforge"):
    rows = []
    for path in Path(root).iterdir():
        rows.append({"path": str(path), "type": "dir" if path.is_dir() else "file"})
    return rows
