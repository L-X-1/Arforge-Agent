"""Safe arithmetic evaluation."""

from __future__ import annotations

from arforge.tools.basic_tools import safe_calculate


def calculate(expression: str):
    return safe_calculate(expression)
