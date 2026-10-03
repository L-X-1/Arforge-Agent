"""Explicit Python compatibility wrapper for the legacy ``ask_user`` tool.

The TypeScript/Core ``question`` tool is the canonical product owner for
session-bound prompts, answer arrays, permission checks, lifecycle events, and
Desktop/Bridge settlement. This module remains importable for legacy Python
callers and fixtures, but is excluded from the default Python registry so it
cannot become a second interactive-question state machine.

The old ``multi_select`` and text-answer shape is intentionally retained only
at this compatibility boundary; new product code must use the TS/Core
``multiple`` and array-answer contract.
"""

from __future__ import annotations

from typing import Any

from arforge.product.question_runtime import (
    QUESTION_PARAM_SCHEMA,
    render_question_result,
    request_questions,
)
from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "ask_user",
    (
        "Ask 1-4 structured questions when execution requires user preferences, "
        "clarification, or a decision. Each question has 2-4 options and clients "
        "also provide a custom-answer choice. Put the recommended option first."
    ),
    params=[
        ParamSchema(
            "questions",
            "array",
            "structured questions to present to the user",
            json_schema=QUESTION_PARAM_SCHEMA,
        ),
        ParamSchema(
            "metadata",
            "object",
            "optional non-sensitive source metadata",
            required=False,
            default=None,
            json_schema={"additionalProperties": True},
        ),
    ],
    risk="medium",
    timeout=300,
    source=__name__,
)
def ask_user_tool(
    questions: list[dict[str, Any]],
    metadata: dict[str, Any] | None = None,
) -> str:
    return render_question_result(request_questions(questions, metadata))
