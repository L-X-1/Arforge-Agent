"""Explicit Python compatibility wrappers for legacy managed worktree tools.

The TypeScript/Core ``Worktree.Service`` and durable ``ControlOperation``
pipeline are the product owners for worktree preparation, ownership checks,
Git mutations, approval, event projection, and Desktop status.  These Python
wrappers remain importable for old fixtures and embedding callers, but are
excluded from the default Python registry so they cannot create a second
worktree state machine.  New product code must use the TypeScript/Core
worktree service and its Desktop/Bridge projections.
"""

from __future__ import annotations

import json
import uuid

from arforge.tool_registry import ParamSchema, register_tool
from arforge.workspace_context import current_session_id
from arforge.worktree_runtime import get_worktree_manager


@register_tool(
    "worktree_status",
    "Show the managed Git worktree owned by the current execution session.",
    params=[],
    risk="low",
    category="read",
    source=__name__,
)
def worktree_status_tool() -> str:
    return json.dumps(
        get_worktree_manager().status(current_session_id()),
        ensure_ascii=False,
        indent=2,
    )


@register_tool(
    "worktree_enter",
    (
        "Create an isolated Git worktree and bind subsequent workspace tools in "
        "this session to it. The source repository must be clean."
    ),
    params=[
        ParamSchema(
            "name",
            "string",
            "optional slash-separated name using letters, digits, dots, underscores, and dashes",
            required=False,
            default="",
        )
    ],
    risk="medium",
    requires_confirmation=True,
    timeout=70,
    category="workspace_cmd",
    source=__name__,
)
def worktree_enter_tool(name: str = "") -> str:
    from arforge.tools.file_tools import get_workspace

    slug = name.strip() or f"session-{uuid.uuid4().hex[:8]}"
    result = get_worktree_manager().enter(
        current_session_id(),
        get_workspace(),
        slug,
    )
    result["message"] = (
        f"Session entered managed worktree {result['worktree_path']} "
        f"on branch {result['worktree_branch']}."
    )
    return json.dumps(result, ensure_ascii=False, indent=2)


@register_tool(
    "worktree_exit",
    (
        "Leave the managed worktree owned by this session. keep preserves the "
        "directory and branch; remove deletes both and refuses unknown or changed "
        "state unless discard_changes is explicitly true."
    ),
    params=[
        ParamSchema(
            "action",
            "string",
            "keep or remove",
            json_schema={"enum": ["keep", "remove"]},
        ),
        ParamSchema(
            "discard_changes",
            "bool",
            "explicitly allow removal with uncommitted files, commits, or unknown state",
            required=False,
            default=False,
        ),
    ],
    risk="high",
    requires_confirmation=True,
    timeout=70,
    category="workspace_cmd",
    source=__name__,
)
def worktree_exit_tool(
    action: str,
    discard_changes: bool = False,
) -> str:
    result = get_worktree_manager().exit(
        current_session_id(),
        action,
        discard_changes=bool(discard_changes),
    )
    if action == "keep":
        result["message"] = (
            f"Session returned to {result['original_root']}; work is preserved "
            f"at {result['worktree_path']}."
        )
    else:
        result["message"] = (
            f"Session returned to {result['original_root']} and removed the "
            "managed worktree and branch."
        )
    return json.dumps(result, ensure_ascii=False, indent=2)
