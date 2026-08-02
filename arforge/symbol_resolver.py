"""Symbol resolution helpers."""

from __future__ import annotations

from arforge.python_ast_indexer import goto_symbol, list_code_symbols


def build_symbol_resolutions():
    return {"success": True, "symbols": len(list_code_symbols(100000))}


def list_symbol_resolutions(limit: int = 100):
    return list_code_symbols(limit)


def resolve_symbol_call(symbol_name: str):
    return goto_symbol(symbol_name)


def list_file_symbol_resolutions(file_path: str):
    return [item for item in list_code_symbols(100000) if item["file"] == file_path]
