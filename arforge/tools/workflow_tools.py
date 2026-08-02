"""Read-only agent tools for inspecting project workflow definitions."""

from __future__ import annotations

import json
from pathlib import Path

from arforge.tool_registry import ParamSchema, register_tool
from arforge.workflow_runtime import WorkflowValidationError, discover_workflows, load_workflow, preview_workflow


def _workflow_workspace() -> Path:
    from arforge.workspace_context import current_session_id
    from arforge.worktree_runtime import get_worktree_manager

    return (
        get_worktree_manager().active_workspace(current_session_id())
        or Path.cwd().resolve()
    )


@register_tool(
    "list_workflows",
    "List validated workflow definition files available in the current project.",
    params=[],
    priority=91,
    risk="low",
    category="read",
    source=__name__,
)
def list_workflows() -> str:
    """List data-only workflow files without importing or executing their contents."""
    workspace = _workflow_workspace()
    items = [path.relative_to(workspace.resolve()).as_posix() for path in discover_workflows(workspace)]
    return json.dumps({"count": len(items), "items": items}, ensure_ascii=False)


@register_tool(
    "preview_workflow",
    "Validate a project workflow JSON file and return its dependency-aware execution preview.",
    params=[ParamSchema("path", "string", "workspace-relative .json workflow path")],
    priority=91,
    risk="low",
    category="read",
    source=__name__,
)
def preview_project_workflow(path: str) -> str:
    """Return a plan only; this tool never starts a model or executes a workflow."""
    try:
        definition = load_workflow(path, workspace=_workflow_workspace())
        return json.dumps(preview_workflow(definition).public(), ensure_ascii=False)
    except WorkflowValidationError as exc:
        return json.dumps({"valid": False, "error": str(exc)}, ensure_ascii=False)
