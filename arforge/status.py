"""Status dashboard helpers."""

from __future__ import annotations

from pathlib import Path

from arforge.memory import get_memory_stats
from arforge.models.token_tracker import list_token_usage


def get_status() -> dict:
    skeleton_count = sum(1 for path in Path("arforge").rglob("*.py") if "__rebuild_status__ = \"source_skeleton\"" in path.read_text(encoding="utf-8"))
    return {
        "brand": "Arforge Agent",
        "memory": get_memory_stats(),
        "recent_token_usage": list_token_usage(limit=5),
        "source_skeleton_modules": skeleton_count,
        "implementation_audit": {
            "source_skeleton_markers": skeleton_count,
            "completeness_proven": False,
            "note": "Marker scan only; use build, contract, integration and user-acceptance gates for readiness.",
        },
    }


def status_text() -> str:
    status = get_status()
    return "\n".join(f"{key}: {value}" for key, value in status.items())
