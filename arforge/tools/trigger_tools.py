"""Provider-neutral trigger lifecycle tools."""

from __future__ import annotations

import json

from arforge.tool_registry import ParamSchema, register_tool
from arforge.trigger_runtime import TriggerRuntimeError, get_trigger_manager
from arforge.workspace_context import current_session_id


@register_tool(
    "trigger_profiles",
    "List host-configured trigger profiles without returning authentication values.",
    params=[],
    risk="low",
    category="read",
    source=__name__,
    should_defer=True,
    search_hint="remote local scheduled trigger profiles automation",
)
def trigger_profiles_tool() -> str:
    profiles = get_trigger_manager().profiles()
    return json.dumps({"items": profiles, "count": len(profiles)}, ensure_ascii=False, indent=2)


@register_tool(
    "trigger_manage",
    (
        "Manage local or authenticated HTTP agent triggers through a host-configured "
        "profile. Supports list, get, create, update, and run. Credentials are added "
        "in-process and are never available to the model or shell."
    ),
    params=[
        ParamSchema(
            "action",
            "string",
            "trigger operation",
            json_schema={"enum": ["list", "get", "create", "update", "run"]},
        ),
        ParamSchema(
            "profile",
            "string",
            "host-configured profile name; defaults to local",
            required=False,
            default="local",
        ),
        ParamSchema(
            "trigger_id",
            "string",
            "required for get, update, and run",
            required=False,
            default="",
        ),
        ParamSchema(
            "body",
            "object",
            "configuration body required for create and update",
            required=False,
            default={},
        ),
    ],
    risk="medium",
    requires_confirmation=True,
    category="network",
    source=__name__,
    should_defer=True,
    search_hint="manage scheduled remote agent triggers create update run",
)
def trigger_manage_tool(
    action: str,
    profile: str = "local",
    trigger_id: str = "",
    body: dict | None = None,
) -> str:
    try:
        result = get_trigger_manager().execute(
            action,
            profile_name=profile,
            session_id=current_session_id(),
            trigger_id=trigger_id,
            body=body or None,
        )
    except TriggerRuntimeError as exc:
        return json.dumps(
            {"ok": False, "code": exc.code, "message": exc.message},
            ensure_ascii=False,
        )
    if result["kind"] == "local" and action == "run":
        result["instruction"] = (
            "The user approved this local trigger. Execute its prompt now through "
            "the current tool and permission pipeline."
        )
    return json.dumps(result, ensure_ascii=False, indent=2)
