"""Tool execution facade — unified entry point for tool matching and execution."""

from __future__ import annotations

from arforge.tool_registry import REGISTRY, ToolResult
from arforge.tools import load_builtin_tools

# Register the same built-in surface used by the Bridge before any direct CLI
# matching or explicit function call is attempted.
load_builtin_tools()


def run_tool_if_match(user_input: str) -> ToolResult | None:
    """Match and execute a tool from natural language input.  Returns None when no tool matches."""
    match = REGISTRY.match(user_input)
    if match is None:
        return None
    return REGISTRY.execute(match)


def execute_tool_by_name(name: str, args: dict | None = None) -> ToolResult:
    """Execute a tool directly by name with explicit args."""
    # Function-calling paths must validate and coerce structured arguments
    # before confirmation. The natural-language matcher remains on execute().
    return REGISTRY.execute_by_name(name, args)


def list_tools() -> list[dict]:
    """Return all registered tools as dicts (schema included)."""
    return REGISTRY.list_tool_dicts()


def get_tool(name: str) -> dict | None:
    """Get a single tool definition by name."""
    tool = REGISTRY.get(name)
    if tool is None:
        return None
    return {
        "name": tool.name,
        "description": tool.description,
        "keywords": tool.keywords,
        "priority": tool.priority,
        "risk": tool.schema.risk_level,
        "source": tool.source,
        "params": [{"name": p.name, "type": p.type, "description": p.description, "required": p.required} for p in tool.schema.params],
    }
