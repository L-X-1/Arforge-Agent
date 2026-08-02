"""Track files changed during agent work."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


DIRTY_FILE = Path(".arforge") / "dirty_files.json"


def _load() -> list[dict]:
    if not DIRTY_FILE.exists():
        return []
    return json.loads(DIRTY_FILE.read_text(encoding="utf-8"))


def _save(rows: list[dict]) -> None:
    DIRTY_FILE.parent.mkdir(parents=True, exist_ok=True)
    DIRTY_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def mark_dirty(file_path: str, reason: str = ""):
    rows = _load()
    rows.append({"file": file_path, "reason": reason, "created_at": datetime.now().isoformat(timespec="seconds"), "resolved": False})
    _save(rows)
    return rows[-1]


def list_dirty_files():
    return [row for row in _load() if not row.get("resolved")]


def detect_dirty_files():
    return list_dirty_files()


def resolve_all_dirty_files():
    rows = _load()
    for row in rows:
        row["resolved"] = True
    _save(rows)
    return {"success": True, "resolved": len(rows)}


def dirty_file_status():
    return {"dirty": len(list_dirty_files())}


def clear_dirty_history():
    _save([])
    return {"success": True}
