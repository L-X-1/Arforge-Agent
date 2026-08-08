"""Compatibility coding-source facade; final input is owned by Context OS."""

from __future__ import annotations

from arforge.context_builder import build_coding_context


def build_context_for_coding(keyword: str):
    return build_coding_context(keyword)
