"""Explicit Python compatibility wrapper for the cooperative wait tool.

The product owner is the TypeScript/Core ``cooperative_wait`` tool.  This
module remains importable for legacy Python loops and fixtures, but is excluded
from the default Python registry so it cannot compete with that owner.
"""

from __future__ import annotations

import json

from arforge.tool_registry import ParamSchema, register_tool
from arforge.wait_runtime import cooperative_wait
from arforge.workspace_context import current_session_id


@register_tool(
    "cooperative_wait",
    (
        "Wait for a bounded duration without starting a shell process. The user "
        "may cancel or wake the wait, and periodic check-in events keep the host informed."
    ),
    params=[
        ParamSchema(
            "duration_seconds",
            "float",
            "total wait duration from 0.05 to 300 seconds",
        ),
        ParamSchema(
            "check_in_interval",
            "float",
            "periodic host check-in interval from 0.05 to 60 seconds",
            required=False,
            default=30.0,
        ),
        ParamSchema(
            "reason",
            "string",
            "brief reason for waiting",
            required=False,
            default="",
        ),
    ],
    risk="low",
    category="read",
    source=__name__,
    should_defer=True,
    search_hint="sleep wait pause wake check in monitor background task",
)
def cooperative_wait_tool(
    duration_seconds: float,
    check_in_interval: float = 30.0,
    reason: str = "",
) -> str:
    result = cooperative_wait(
        current_session_id(),
        duration_seconds,
        check_in_interval=check_in_interval,
        reason=reason,
    )
    return json.dumps(result, ensure_ascii=False, indent=2)
