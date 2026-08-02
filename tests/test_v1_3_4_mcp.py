"""v1-3.4 MCP 接入测试（真实子进程 stdio JSON-RPC）。"""

from __future__ import annotations

import sys


def _server_cmd():
    return [sys.executable, "-m", "arforge.mcp_test_server"]


# -- JSON-RPC 原语 ------------------------------------------------------------


def test_make_and_parse_request():
    from arforge.mcp_client import make_request, parse_response

    req = make_request("tools/list", {})
    assert req["method"] == "tools/list"
    resp = parse_response('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
    assert resp["result"]["ok"] is True


# -- 真实 stdio 连接 ----------------------------------------------------------


def test_connection_initialize_list_call():
    from arforge.mcp_client import MCPConnection

    conn = MCPConnection(_server_cmd())
    try:
        info = conn.initialize()
        assert info.get("serverInfo", {}).get("name") == "arforge-test-server"
        names = [t["name"] for t in conn.list_tools()]
        assert "echo" in names and "add" in names
        assert "hello" in str(conn.call_tool("echo", {"text": "hello"}))
        assert "5" in str(conn.call_tool("add", {"a": 2, "b": 3}))
    finally:
        conn.close()


def test_connection_context_manager():
    from arforge.mcp_client import MCPConnection

    with MCPConnection(_server_cmd()) as conn:
        conn.initialize()
        assert conn.list_tools()


# -- 动态注册进 Agent 工具表 -------------------------------------------------


def test_register_mcp_server_into_registry():
    from arforge.tool_registry import REGISTRY
    from arforge.tools.mcp_tools import register_mcp_server, unregister_mcp_tools

    conn, names = register_mcp_server("test", _server_cmd())
    try:
        assert "mcp_test_echo" in names
        assert "mcp_test_add" in names
        # 经全局注册表按工具名 + 结构化参数调用（agent 路径）
        res = REGISTRY.execute_by_name("mcp_test_add", {"a": 4, "b": 6})
        assert res.success, res.error
        assert "10" in res.output
        # category=network（受权限管控）
        assert REGISTRY.get("mcp_test_echo").schema.category == "network"
    finally:
        conn.close()
        unregister_mcp_tools(names)
        assert REGISTRY.get("mcp_test_echo") is None  # 清理生效


def test_format_result_text_and_error():
    from arforge.tools.mcp_tools import _format_result

    assert _format_result({"content": [{"type": "text", "text": "hi"}]}) == "hi"
    assert _format_result({"isError": True, "content": [{"type": "text", "text": "boom"}]}).startswith("ERROR:")
