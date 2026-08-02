"""Code navigation question answering."""

from __future__ import annotations

from arforge.semantic_code_search import semantic_code_search_brief
from arforge.symbol_navigator import navigation_answer as _symbol_navigation_answer


def navigation_answer_for_code(question: str) -> str:
    symbols = _symbol_navigation_answer(question)
    if symbols != "No symbol found.":
        return symbols
    return semantic_code_search_brief(question)


def navigation_answer(question: str):
    return navigation_answer_for_code(question)
