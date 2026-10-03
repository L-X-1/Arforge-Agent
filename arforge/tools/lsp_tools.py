"""Legacy read-only language-service compatibility tools.

The product runtime is now the TypeScript ``lsp`` tool.  This module remains
importable for explicit Python integrations and migration fixtures, but is
intentionally excluded from ``BUILTIN_TOOL_MODULES`` and the deferred default
registry so it cannot become a second default tool owner.
"""

from __future__ import annotations

import json

from arforge.lsp_runtime import OPERATIONS, get_lsp_manager
from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "language_service_status",
    "List installed and running language-service backends for the active workspace.",
    params=[],
    risk="low",
    timeout=10,
    category="read",
    source=__name__,
)
def language_service_status_tool() -> str:
    from arforge.tools.file_tools import get_workspace

    return json.dumps(
        get_lsp_manager(get_workspace()).server_status(),
        ensure_ascii=False,
        indent=2,
    )


@register_tool(
    "language_service",
    (
        "Query code intelligence for definitions, references, hover information, "
        "document/workspace symbols, implementations, call hierarchy, and diagnostics. "
        "Uses an installed language server when available and reports an index fallback otherwise."
    ),
    params=[
        ParamSchema(
            "operation",
            "string",
            "one of: " + ", ".join(sorted(OPERATIONS)),
            json_schema={"enum": sorted(OPERATIONS)},
        ),
        ParamSchema("filename", "path", "source file inside the workspace"),
        ParamSchema("line", "int", "1-based line number"),
        ParamSchema("character", "int", "1-based character offset"),
    ],
    risk="low",
    timeout=30,
    category="read",
    source=__name__,
)
def language_service_tool(
    operation: str,
    filename: str,
    line: int,
    character: int,
) -> str:
    from arforge.tools.file_tools import _resolve, get_workspace

    target = _resolve(filename)
    result = get_lsp_manager(get_workspace()).query(
        operation,
        target,
        int(line),
        int(character),
    )
    return json.dumps(result, ensure_ascii=False, indent=2)
