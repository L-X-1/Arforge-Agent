"""Code analysis slash helpers."""

from __future__ import annotations

from arforge.context_builder import build_coding_context
from arforge.python_ast_indexer import goto_symbol


def code_context(query: str) -> str:
    return build_coding_context(query)


def symbol(query: str) -> str:
    return str(goto_symbol(query))
