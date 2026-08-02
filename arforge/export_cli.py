"""Local data export helpers."""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3

from arforge.memory import query_memories
from arforge.models.token_tracker import list_token_usage
from arforge.paths import data_path


def export_data(output_path: str | Path = None) -> dict:
    data = {
        "memories": query_memories(limit=1000),
        "token_usage": list_token_usage(limit=1000),
        "conversations": _export_conversations(),
    }
    if output_path:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def _export_conversations() -> dict:
    """Read the local Bridge history without starting or mutating the runtime."""
    path = data_path("state", "bridge_state.db")
    empty = {"projects": [], "sessions": [], "messages": []}
    if not path.is_file():
        return empty
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        tables = {
            row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if not {"bridge_projects", "bridge_sessions", "bridge_messages"}.issubset(tables):
            return empty
        return {
            "projects": [dict(row) for row in connection.execute(
                "SELECT * FROM bridge_projects ORDER BY updated_at DESC"
            )],
            "sessions": [dict(row) for row in connection.execute(
                "SELECT * FROM bridge_sessions ORDER BY updated_at DESC"
            )],
            "messages": [dict(row) for row in connection.execute(
                "SELECT * FROM bridge_messages ORDER BY session_id, sequence"
            )],
        }
    finally:
        connection.close()


def main(output_path: str = "arforge-export.json") -> int:
    export_data(output_path)
    print(output_path)
    return 0
