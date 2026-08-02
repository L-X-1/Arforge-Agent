"""Symbol reference index."""

from __future__ import annotations

from arforge.analysis_index import get_analysis_index


def index_references() -> dict:
    return {"success": True, "references": len(list_reference_index(100000))}


def list_reference_index(limit: int = 100):
    rows = []
    for path, item in get_analysis_index().items():
        rows.extend({**row, "file": row.get("file", path)} for row in item.imports)
        rows.extend(item.calls)
        rows.extend(item.assignments)
        rows.extend(item.symbols)
    return rows[:limit]


def find_references(symbol_name: str, limit: int = 50):
    needle = symbol_name.lower()
    return [
        row
        for row in list_reference_index(100000)
        if needle in row.get("name", "").lower() or needle in row.get("module", "").lower()
    ][:limit]
