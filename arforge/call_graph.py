"""Function call graph."""

from __future__ import annotations

from arforge.analysis_index import get_analysis_index


def index_call_graph() -> dict:
    return {"success": True, "calls": len(list_call_graph(100000))}


def list_call_graph(limit: int = 100):
    rows = []
    for path, item in get_analysis_index().items():
        rows.extend(item.calls)
    return rows[:limit]


def list_callers(callee_name: str, limit: int = 50):
    return [row for row in list_call_graph(100000) if callee_name in row["name"]][:limit]


def list_callees(caller_name: str, limit: int = 50):
    return [row for row in list_call_graph(100000) if caller_name in row.get("scope", "")][:limit]
