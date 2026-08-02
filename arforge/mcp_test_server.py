"""一个真实的 stdio MCP-style 测试 server（v1-3.4）。

既保留进程内函数（被 mcp_tools 复用），又提供 ``serve()`` 主循环——可作为子进程被
``MCPConnection`` 通过 stdio JSON-RPC 真实拉起、initialize/tools-list/tools-call。
运行：``python -m arforge.mcp_test_server``。
"""

from __future__ import annotations

from arforge.mcp_client import make_request


def list_tools() -> list[dict]:
    return [
        {
            "name": "echo",
            "description": "Echo the given text back",
            "inputSchema": {
                "type": "object",
                "properties": {"text": {"type": "string", "description": "text to echo"}},
            },
        },
        {
            "name": "add",
            "description": "Add two integers a and b",
            "inputSchema": {
                "type": "object",
                "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
            },
        },
    ]


def call_tool(name: str, arguments: dict = None) -> dict:
    args = arguments or {}
    if name == "echo":
        return {"content": [{"type": "text", "text": str(args.get("text", ""))}]}
    if name == "add":
        try:
            total = int(args.get("a", 0)) + int(args.get("b", 0))
        except (TypeError, ValueError):
            return {"isError": True, "content": [{"type": "text", "text": "a/b must be integers"}]}
        return {"content": [{"type": "text", "text": str(total)}]}
    return {"isError": True, "content": [{"type": "text", "text": f"unknown tool: {name}"}]}


def initialize_response() -> dict:
    return {"protocolVersion": "2024-11-05", "serverInfo": {"name": "arforge-test-server", "version": "0.1.0"}}


def sample_initialize_request() -> dict:
    return make_request("initialize", {})


def serve(stdin=None, stdout=None) -> None:
    """真实 stdio MCP server 主循环（newline-delimited JSON-RPC，一问一答）。"""
    import json
    import sys

    inp = stdin or sys.stdin
    out = stdout or sys.stdout
    for line in inp:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = req.get("method")
        rid = req.get("id")
        if method == "initialize":
            result = initialize_response()
        elif method == "tools/list":
            result = {"tools": list_tools()}
        elif method == "tools/call":
            params = req.get("params", {}) or {}
            result = call_tool(params.get("name"), params.get("arguments"))
        else:
            result = {}
        out.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}, ensure_ascii=False) + "\n")
        out.flush()


if __name__ == "__main__":
    serve()
