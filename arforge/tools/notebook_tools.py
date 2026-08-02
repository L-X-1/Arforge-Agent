"""Structured notebook tools."""

from __future__ import annotations

import json

from arforge.notebook_runtime import CELL_TYPES, EDIT_MODES, NotebookService
from arforge.tool_registry import ParamSchema, register_tool


def _service() -> NotebookService:
    from arforge.tools.file_tools import get_workspace

    return NotebookService(get_workspace())


@register_tool(
    "notebook_read",
    (
        "Read a Jupyter notebook as structured cells and return a content hash. "
        "Use the returned sha256 as expected_sha256 before editing."
    ),
    params=[
        ParamSchema("notebook_path", "path", "notebook path inside an authorized workspace"),
        ParamSchema("start", "int", "zero-based first cell index", required=False, default=0),
        ParamSchema("limit", "int", "number of cells to return (1-100)", required=False, default=20),
        ParamSchema(
            "include_outputs",
            "bool",
            "include complete code-cell outputs when true",
            required=False,
            default=False,
        ),
    ],
    risk="low",
    timeout=10,
    category="read",
    source=__name__,
)
def notebook_read_tool(
    notebook_path: str,
    start: int = 0,
    limit: int = 20,
    include_outputs: bool = False,
) -> str:
    result = _service().read(
        notebook_path,
        start=int(start),
        limit=int(limit),
        include_outputs=bool(include_outputs),
    )
    return json.dumps(result, ensure_ascii=False, indent=2)


@register_tool(
    "notebook_edit",
    (
        "Structurally replace, insert, or delete one Jupyter notebook cell. "
        "The notebook must be read first and expected_sha256 must match. "
        "Replacing a code cell clears stale execution results."
    ),
    params=[
        ParamSchema("notebook_path", "path", "notebook path inside an authorized workspace"),
        ParamSchema(
            "expected_sha256",
            "string",
            "sha256 returned by notebook_read; prevents overwriting external changes",
        ),
        ParamSchema(
            "edit_mode",
            "string",
            "replace, insert, or delete",
            required=False,
            default="replace",
            json_schema={"enum": sorted(EDIT_MODES)},
        ),
        ParamSchema(
            "cell_id",
            "string",
            "stable cell id or cell-N locator; omit to insert at the beginning",
            required=False,
            default="",
        ),
        ParamSchema(
            "new_source",
            "string",
            "complete source for replace or insert",
            required=False,
            default="",
        ),
        ParamSchema(
            "cell_type",
            "string",
            "code, markdown, or raw; required for insert",
            required=False,
            default="",
            json_schema={"enum": ["", *sorted(CELL_TYPES)]},
        ),
        ParamSchema(
            "dry_run",
            "bool",
            "return the structured preview without writing",
            required=False,
            default=False,
        ),
    ],
    risk="medium",
    requires_confirmation=True,
    timeout=15,
    category="workspace_write",
    source=__name__,
)
def notebook_edit_tool(
    notebook_path: str,
    expected_sha256: str,
    edit_mode: str = "replace",
    cell_id: str = "",
    new_source: str = "",
    cell_type: str = "",
    dry_run: bool = False,
) -> str:
    result = _service().edit(
        notebook_path,
        expected_sha256=expected_sha256,
        edit_mode=edit_mode,
        cell_id=cell_id or None,
        new_source=new_source,
        cell_type=cell_type or None,
        dry_run=bool(dry_run),
    )
    return json.dumps(result, ensure_ascii=False, indent=2)
