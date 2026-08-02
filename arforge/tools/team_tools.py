"""Session-owned team lifecycle and mailbox tools."""

from __future__ import annotations

import json

from arforge.team_runtime import TeamRuntimeError, get_team_manager
from arforge.tool_registry import ParamSchema, register_tool
from arforge.workspace_context import current_session_id


def _actor() -> str:
    from arforge.multiagent.security import current_active_role

    role = current_active_role()
    role_name = role.name if role is not None else None
    return get_team_manager().resolve_actor(current_session_id(), role_name)


def _json_call(fn, *args, **kwargs) -> str:
    try:
        result = fn(*args, **kwargs)
    except TeamRuntimeError as exc:
        return json.dumps(
            {"success": False, "code": exc.code, "message": exc.message},
            ensure_ascii=False,
        )
    return json.dumps({"success": True, "data": result}, ensure_ascii=False, indent=2)


@register_tool(
    "team_create",
    "Create one durable collaboration team owned by the current lead session.",
    params=[
        ParamSchema("name", "string", "team display name"),
        ParamSchema("description", "string", "team purpose", required=False, default=""),
    ],
    risk="medium",
    category="workspace_write",
    source=__name__,
    should_defer=True,
    search_hint="create persistent multiagent team collaborators",
)
def team_create(name: str, description: str = "") -> str:
    return _json_call(get_team_manager().create, current_session_id(), name, description)


@register_tool(
    "team_get",
    "Show the current session-owned team and member lifecycle states.",
    params=[],
    risk="low",
    category="read",
    source=__name__,
    should_defer=True,
    search_hint="team members status collaboration",
)
def team_get() -> str:
    return _json_call(get_team_manager().get, current_session_id())


@register_tool(
    "team_member_add",
    "Register a bounded team member backed by one existing subagent role.",
    params=[
        ParamSchema("member_name", "string", "unique member name"),
        ParamSchema("role", "string", "registered Arforge subagent role"),
    ],
    risk="medium",
    category="workspace_write",
    source=__name__,
    should_defer=True,
    search_hint="add teammate subagent role member",
)
def team_member_add(member_name: str, role: str) -> str:
    return _json_call(
        get_team_manager().add_member,
        current_session_id(),
        member_name,
        role,
        actor=_actor(),
    )


@register_tool(
    "team_message_send",
    "Send a direct message to one current team member or broadcast with recipient '*'.",
    params=[
        ParamSchema("recipient", "string", "member name or * for team broadcast"),
        ParamSchema("message", "string", "bounded message content"),
        ParamSchema("summary", "string", "short inbox preview", required=False, default=""),
        ParamSchema(
            "kind",
            "string",
            "info, request, result, or alert",
            required=False,
            default="info",
            json_schema={"enum": ["info", "request", "result", "alert"]},
        ),
    ],
    risk="low",
    category="read",
    source=__name__,
    should_defer=False,
    search_hint="send direct broadcast teammate mailbox message",
)
def team_message_send(
    recipient: str,
    message: str,
    summary: str = "",
    kind: str = "info",
) -> str:
    return _json_call(
        get_team_manager().send_message,
        current_session_id(),
        recipient,
        message,
        actor=_actor(),
        summary=summary,
        kind=kind,
    )


@register_tool(
    "team_message_list",
    "Read messages addressed to the current lead or registered subagent member.",
    params=[
        ParamSchema("after_sequence", "int", "return newer messages only", required=False, default=0),
        ParamSchema("limit", "int", "maximum messages, 1-100", required=False, default=50),
    ],
    risk="low",
    category="read",
    source=__name__,
    should_defer=False,
    search_hint="read team mailbox inbox messages",
)
def team_message_list(after_sequence: int = 0, limit: int = 50) -> str:
    return _json_call(
        get_team_manager().list_messages,
        current_session_id(),
        actor=_actor(),
        after_sequence=after_sequence,
        limit=limit,
    )


@register_tool(
    "team_shutdown_request",
    "Ask an active team member to stop gracefully before removal or team deletion.",
    params=[
        ParamSchema("member_name", "string", "target team member"),
        ParamSchema("reason", "string", "shutdown reason", required=False, default=""),
    ],
    risk="medium",
    category="workspace_write",
    source=__name__,
    should_defer=True,
    search_hint="request graceful teammate shutdown",
)
def team_shutdown_request(member_name: str, reason: str = "") -> str:
    return _json_call(
        get_team_manager().request_shutdown,
        current_session_id(),
        member_name,
        reason,
        actor=_actor(),
    )


@register_tool(
    "team_shutdown_respond",
    "Approve or reject the current member's own pending shutdown request.",
    params=[
        ParamSchema("request_id", "string", "pending shutdown request id"),
        ParamSchema("approve", "bool", "true to stop, false to continue"),
        ParamSchema("reason", "string", "required when rejecting", required=False, default=""),
    ],
    risk="low",
    category="read",
    source=__name__,
    should_defer=False,
    search_hint="respond approve reject graceful shutdown",
)
def team_shutdown_respond(
    request_id: str,
    approve: bool,
    reason: str = "",
) -> str:
    return _json_call(
        get_team_manager().respond_shutdown,
        current_session_id(),
        request_id,
        approve,
        reason,
        actor=_actor(),
    )


@register_tool(
    "team_member_remove",
    "Remove a team member only after that member approved graceful shutdown.",
    params=[ParamSchema("member_name", "string", "stopped team member")],
    risk="medium",
    category="workspace_write",
    source=__name__,
    should_defer=True,
    search_hint="remove stopped teammate member",
)
def team_member_remove(member_name: str) -> str:
    return _json_call(
        get_team_manager().remove_member,
        current_session_id(),
        member_name,
        actor=_actor(),
    )


@register_tool(
    "team_delete",
    "Delete the current session-owned team after every collaborator has stopped.",
    params=[],
    risk="medium",
    category="workspace_write",
    source=__name__,
    should_defer=True,
    search_hint="delete disband cleanup team",
)
def team_delete() -> str:
    return _json_call(get_team_manager().delete, current_session_id(), actor=_actor())
