"""MCP tool facades + 动态注册（v1-3.4）。

把外部 MCP server 的工具动态注册进 Arforge 全局工具表（REGISTRY），让 agent 像调用
本地工具一样调用 MCP server 暴露的工具。连接走真实 stdio JSON-RPC（MCPConnection）。
"""

from __future__ import annotations

import json

from arforge.mcp_client import MCPConnection, make_request, parse_response
from arforge.mcp_test_server import (
    call_tool,
    initialize_response,
    list_tools,
    sample_initialize_request,
)

__all__ = [
    "make_request",
    "parse_response",
    "MCPConnection",
    "call_tool",
    "initialize_response",
    "list_tools",
    "sample_initialize_request",
    "register_mcp_server",
    "unregister_mcp_tools",
]

_TYPE_MAP = {"string": "string", "integer": "int", "number": "float", "boolean": "bool"}


def _format_result(res: dict) -> str:
    """把 MCP tools/call 结果转成 agent 可读文本。"""
    content = res.get("content", [])
    if isinstance(content, list):
        texts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
        if texts:
            prefix = "ERROR: " if res.get("isError") else ""
            return prefix + "\n".join(texts)
    return json.dumps(res, ensure_ascii=False)


def register_mcp_server(server_name: str, command: list, cwd: str | None = None):
    """连接 MCP server，把它的 tools 动态注册进全局 REGISTRY。

    返回 ``(connection, [registered_tool_names])``。connection 在使用期间需保持打开，
    用完 ``close()``；可用 ``unregister_mcp_tools`` 清理注册的工具。
    工具名格式：``mcp_<server_name>_<tool>``，category=network（受三模式权限管控）。
    """
    from arforge.tool_registry import REGISTRY, ParamSchema, ToolDefinition, ToolSchema

    conn = MCPConnection(command, cwd=cwd)
    conn.initialize()
    registered: list[str] = []
    for t in conn.list_tools():
        mcp_name = t.get("name")
        if not mcp_name:
            continue
        tool_name = f"mcp_{server_name}_{mcp_name}"
        params = []
        for pname, pdef in ((t.get("inputSchema") or {}).get("properties", {})).items():
            ptype = _TYPE_MAP.get((pdef or {}).get("type", "string"), "string")
            params.append(ParamSchema(pname, ptype, (pdef or {}).get("description", ""), required=False))

        def _make_exec(_name=mcp_name, _conn=conn):
            def _exec(**kwargs):
                return _format_result(_conn.call_tool(_name, kwargs))

            return _exec

        REGISTRY.register(
            ToolDefinition(
                name=tool_name,
                description=f"[MCP:{server_name}] {t.get('description', '')}",
                schema=ToolSchema(
                    tool_name,
                    t.get("description", ""),
                    params=params,
                    risk_level="medium",
                    category="network",
                    should_defer=True,
                ),
                execute_fn=_make_exec(),
                source=f"mcp:{server_name}",
                search_hint=f"{server_name} external MCP tool {mcp_name}",
            )
        )
        registered.append(tool_name)
    return conn, registered


def unregister_mcp_tools(tool_names) -> None:
    """从 REGISTRY 移除之前注册的 MCP 工具。"""
    from arforge.tool_registry import REGISTRY

    for n in tool_names:
        REGISTRY.tools.pop(n, None)
