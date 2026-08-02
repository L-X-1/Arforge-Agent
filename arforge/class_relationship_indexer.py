"""Class relationship index."""

from __future__ import annotations

from arforge.analysis_index import get_analysis_index


def index_class_relationships():
    return {"success": True, "classes": len(list_class_relationships(100000))}


def list_class_relationships(limit: int = 100):
    rows = []
    for path, item in get_analysis_index().items():
        rows.extend(item.classes)
    return rows[:limit]


def list_class_methods(class_name: str):
    symbols = []
    for path, item in get_analysis_index().items():
        for symbol in item.symbols:
            if symbol["kind"] == "function" and class_name.lower() in symbol["file"].lower():
                symbols.append(symbol)
    return symbols


def list_class_attributes(class_name: str):
    return []


def list_class_instantiations(class_name: str):
    return [row for row in get_analysis_index().values() for row in row.calls if row["name"].endswith(class_name)]
