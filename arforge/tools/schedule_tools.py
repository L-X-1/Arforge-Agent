"""Tools for session-owned scheduled prompts."""

from __future__ import annotations

import json

from arforge.scheduled_prompt_runtime import get_scheduled_prompt_manager
from arforge.tool_registry import ParamSchema, register_tool
from arforge.workspace_context import current_session_id


@register_tool(
    "schedule_create",
    (
        "Schedule a prompt for the current session using a standard five-field "
        "local-time cron expression. Supports one-shot and recurring jobs; "
        "durable jobs survive process restarts."
    ),
    params=[
        ParamSchema("cron", "string", "minute hour day-of-month month day-of-week"),
        ParamSchema("prompt", "string", "prompt to enqueue when the schedule fires"),
        ParamSchema(
            "recurring",
            "bool",
            "repeat on every match; false fires once",
            required=False,
            default=True,
        ),
        ParamSchema(
            "durable",
            "bool",
            "persist across process restarts",
            required=False,
            default=False,
        ),
    ],
    risk="medium",
    requires_confirmation=True,
    category="workspace_write",
    source=__name__,
)
def schedule_create_tool(
    cron: str,
    prompt: str,
    recurring: bool = True,
    durable: bool = False,
) -> str:
    result = get_scheduled_prompt_manager().create(
        current_session_id(),
        cron,
        prompt,
        recurring=bool(recurring),
        durable=bool(durable),
    )
    return json.dumps(result, ensure_ascii=False, indent=2)


@register_tool(
    "schedule_list",
    "List scheduled prompts owned by the current session.",
    params=[],
    risk="low",
    category="read",
    source=__name__,
)
def schedule_list_tool() -> str:
    jobs = get_scheduled_prompt_manager().list(current_session_id())
    return json.dumps({"jobs": jobs, "count": len(jobs)}, ensure_ascii=False, indent=2)


@register_tool(
    "schedule_delete",
    "Cancel a scheduled prompt owned by the current session.",
    params=[ParamSchema("job_id", "string", "job id returned by schedule_create")],
    risk="medium",
    requires_confirmation=True,
    category="workspace_write",
    source=__name__,
)
def schedule_delete_tool(job_id: str) -> str:
    result = get_scheduled_prompt_manager().delete(current_session_id(), job_id)
    return json.dumps(result, ensure_ascii=False, indent=2)


@register_tool(
    "schedule_run_missed",
    (
        "Consume a missed one-shot scheduled prompt after the user explicitly "
        "confirms it should run in the current turn."
    ),
    params=[ParamSchema("job_id", "string", "missed job id")],
    risk="medium",
    requires_confirmation=True,
    category="workspace_cmd",
    source=__name__,
)
def schedule_run_missed_tool(job_id: str) -> str:
    result = get_scheduled_prompt_manager().consume_for_current_turn(
        current_session_id(),
        job_id,
    )
    return json.dumps(
        {
            "job_id": result["id"],
            "approved_scheduled_prompt": result["prompt"],
            "instruction": (
                "The user explicitly approved this missed prompt. Execute it now "
                "through the normal tool and permission pipeline."
            ),
        },
        ensure_ascii=False,
        indent=2,
    )
