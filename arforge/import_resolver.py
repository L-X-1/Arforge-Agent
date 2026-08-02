"""Import resolution helpers."""

from __future__ import annotations

from arforge.analysis_index import get_analysis_index


def build_import_bindings():
    return {"success": True, "bindings": len(list_import_bindings(100000))}


def list_import_bindings(limit: int = 100):
    rows = []
    for path, item in get_analysis_index().items():
        for imp in item.imports:
            rows.append({"file": path, **imp})
    return rows[:limit]


def find_imported_symbol(symbol_name: str):
    return [row for row in list_import_bindings(100000) if row.get("name") == symbol_name or row.get("asname") == symbol_name]


def find_import_alias(alias_name: str):
    return [row for row in list_import_bindings(100000) if row.get("asname") == alias_name]


def list_imports_by_category(category: str):
    if category == "internal":
        return [row for row in list_import_bindings(100000) if str(row.get("module", "")).startswith("arforge")]
    if category == "external":
        return [row for row in list_import_bindings(100000) if not str(row.get("module", "")).startswith("arforge")]
    return list_import_bindings()
