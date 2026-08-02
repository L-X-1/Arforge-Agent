"""Symbol navigation facade."""

from __future__ import annotations

from arforge.python_ast_indexer import search_symbol


def navigation_answer(question: str):
    matches = search_symbol(question)
    if not matches:
        return "No symbol found."
    return "\n".join(f"{item['name']} -> {item['file']}:{item['line']}" for item in matches[:10])
