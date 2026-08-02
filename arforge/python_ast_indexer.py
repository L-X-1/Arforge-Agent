"""Python AST symbol indexing."""

from __future__ import annotations

import ast
from pathlib import Path

from arforge.project_scanner import scan_project


_SYMBOLS: list[dict] = []
_INDEX_ROOT: Path | None = None


def index_python_ast(root: str | Path = ".") -> dict:
    global _INDEX_ROOT, _SYMBOLS
    base = Path(root).resolve()
    symbols = []
    for item in scan_project(base, suffixes=(".py",)):
        path = base / item["path"]
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                symbols.append({"name": node.name, "kind": node.__class__.__name__, "file": item["path"], "line": node.lineno})
    _SYMBOLS = symbols
    _INDEX_ROOT = base
    return {"success": True, "symbols": len(symbols)}


def _ensure_index() -> None:
    # Respect an explicit ``index_python_ast(root)`` call while that root is
    # still valid. Temporary project indexes must not be replaced merely
    # because the process working directory differs. Once a temporary root is
    # removed, rebuild against the current project to avoid stale cross-test
    # and cross-workspace results.
    if not _SYMBOLS or _INDEX_ROOT is None or not _INDEX_ROOT.exists():
        index_python_ast()


def list_code_symbols(limit: int = 100):
    _ensure_index()
    return _SYMBOLS[:limit]


def search_symbol(symbol_name: str, match_mode: str = "substring") -> list[dict]:
    """Search indexed symbols by name with selectable match precision.

    match_mode:
      - "exact"     — name == symbol_name (case-insensitive)
      - "prefix"    — name starts with symbol_name
      - "substring" — symbol_name anywhere in name (legacy behavior)
    """
    _ensure_index()
    target = symbol_name.lower()
    if match_mode == "exact":
        return [item for item in _SYMBOLS if item["name"].lower() == target]
    if match_mode == "prefix":
        return [item for item in _SYMBOLS if item["name"].lower().startswith(target)]
    # substring (default)
    return [item for item in _SYMBOLS if target in item["name"].lower()]


def goto_symbol(symbol_name: str, match_mode: str = "substring"):
    matches = search_symbol(symbol_name, match_mode)
    return matches[0] if matches else None


def list_file_symbols(file_path: str):
    _ensure_index()
    return [item for item in _SYMBOLS if item["file"] == file_path]
