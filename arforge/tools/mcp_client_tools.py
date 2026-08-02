"""Read-only agent tools for explicitly configured MCP client connections."""

from __future__ import annotations

import json

from arforge.mcp_client_runtime import MCPClientError, get_mcp_client_manager
from arforge.tool_registry import ParamSchema, register_tool


def _call(fn, *args, **kwargs) -> str:
    try:
        result = fn(*args, **kwargs)
    except MCPClientError as exc:
        return json.dumps(
            {"success": False, "code": exc.code, "message": exc.message},
            ensure_ascii=False,
        )
    return json.dumps({"success": True, "data": result}, ensure_ascii=False, indent=2)


@register_tool(
    "mcp_client_servers",
    "List MCP servers explicitly connected by the local host application.",
    params=[],
    risk="low",
    category="read",
    source=__name__,
    should_defer=True,
    search_hint="external MCP connected servers status",
)
def mcp_client_servers() -> str:
    return _call(get_mcp_client_manager().list_servers)


@register_tool(
    "mcp_resource_list",
    "List read-only resources exposed by one explicitly connected MCP server.",
    params=[ParamSchema("server_name", "string", "configured MCP server name")],
    risk="low",
    category="network",
    source=__name__,
    should_defer=True,
    search_hint="MCP resources list external context",
)
def mcp_resource_list(server_name: str) -> str:
    return _call(get_mcp_client_manager().list_resources, server_name)


@register_tool(
    "mcp_resource_read",
    "Read one resource URI from an explicitly connected MCP server.",
    params=[
        ParamSchema("server_name", "string", "configured MCP server name"),
        ParamSchema("uri", "string", "resource URI returned by mcp_resource_list"),
    ],
    risk="low",
    category="network",
    source=__name__,
    should_defer=True,
    search_hint="MCP resource read fetch external context URI",
)
def mcp_resource_read(server_name: str, uri: str) -> str:
    return _call(get_mcp_client_manager().read_resource, server_name, uri)


@register_tool(
    "mcp_tools_refresh",
    "Refresh tool schemas for one connected MCP server and update deferred agent tools.",
    params=[ParamSchema("server_name", "string", "configured MCP server name")],
    risk="medium",
    category="network",
    source=__name__,
    should_defer=True,
    search_hint="refresh dynamic MCP tool schemas list changed",
)
def mcp_tools_refresh(server_name: str) -> str:
    return _call(get_mcp_client_manager().refresh_tools, server_name)
