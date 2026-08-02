"""MCP Server Framework — reusable base for building MCP-compatible servers.

M0 地基 (T29)：Protocol + StdioTransport + ToolRegistry + 基础工具 + 契约测试。

Usage:
    from arforge.mcp_server import MCPServer, tool

    server = MCPServer("my-server", "0.1.0")

    @server.tool()
    def echo(text: str) -> str:
        return text

    @server.tool()
    def add(a: int, b: int) -> str:
        return str(a + b)

    server.run()  # stdio loop
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Callable



# ---------------------------------------------------------------------------
# Tool definition
# ---------------------------------------------------------------------------


@dataclass
class MCPTool:
    name: str
    description: str
    input_schema: dict
    handler: Callable[..., str]

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        }


def _python_type_to_json_type(ptype: type) -> str:
    mapping = {str: "string", int: "integer", float: "number", bool: "boolean"}
    return mapping.get(ptype, "string")


def _build_input_schema(func: Callable, description: str) -> dict:
    """Auto-build JSON Schema from Python function signature."""
    import inspect

    sig = inspect.signature(func)
    properties = {}
    required = []

    for name, param in sig.parameters.items():
        if name == "self":
            continue
        ptype = str if param.annotation is inspect.Parameter.empty else param.annotation
        json_type = _python_type_to_json_type(ptype)
        properties[name] = {"type": json_type}
        if param.default is inspect.Parameter.empty:
            required.append(name)

    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "description": description,
    }


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------


class ToolRegistry:
    """Registry of MCP tools with schema."""

    def __init__(self) -> None:
        self._tools: dict[str, MCPTool] = {}

    def register(
        self,
        name: str,
        handler: Callable[..., str],
        description: str = "",
        input_schema: dict | None = None,
    ) -> None:
        schema = input_schema or _build_input_schema(handler, description)
        self._tools[name] = MCPTool(
            name=name,
            description=description,
            input_schema=schema,
            handler=handler,
        )

    def list_tools(self) -> list[dict]:
        return [t.to_dict() for t in self._tools.values()]

    def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        tool = self._tools.get(name)
        if tool is None:
            return {"isError": True, "content": [{"type": "text", "text": f"Unknown tool: {name}"}]}

        args = arguments or {}
        try:
            result = tool.handler(**args)
        except TypeError as e:
            return {"isError": True, "content": [{"type": "text", "text": f"Invalid arguments: {e}"}]}
        except Exception as e:
            return {"isError": True, "content": [{"type": "text", "text": f"Tool error: {e}"}]}

        return {"content": [{"type": "text", "text": str(result)}]}

    def __len__(self) -> int:
        return len(self._tools)


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------


class MCPServer:
    """Reusable MCP server with stdio transport.

    Usage:
        server = MCPServer("my-server", "0.1.0")

        @server.tool(description="Echo back text")
        def echo(text: str) -> str:
            return text

        server.run()
    """

    def __init__(self, name: str, version: str) -> None:
        from arforge.mcp_ecosystem import PromptRegistry, ResourceRegistry

        self.name = name
        self.version = version
        self.registry = ToolRegistry()
        self.resources = ResourceRegistry()
        self.prompts = PromptRegistry()
        self._initialized = False

    def tool(self, description: str = "", input_schema: dict | None = None):
        """Decorator to register a function as an MCP tool."""

        def decorator(func: Callable[..., str]):
            name = func.__name__
            self.registry.register(name, func, description, input_schema)
            return func

        return decorator

    def handle_request(self, request: dict) -> dict:
        """Handle a single JSON-RPC request and return a response."""
        method = request.get("method", "")
        req_id = request.get("id")
        params = request.get("params", {})

        try:
            if method == "initialize":
                result = self._handle_initialize(params)
            elif method == "tools/list":
                result = self._handle_tools_list()
            elif method == "tools/call":
                result = self._handle_tools_call(params)
            elif method == "resources/list":
                result = {"resources": self.resources.list_resources()}
            elif method == "resources/read":
                result = self.resources.read_resource(str(params.get("uri", "")))
            elif method == "prompts/list":
                result = {"prompts": self.prompts.list_prompts()}
            elif method == "prompts/get":
                result = self.prompts.get_prompt(
                    str(params.get("name", "")),
                    params.get("arguments", {}),
                )
            elif method == "ping":
                result = {}
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                }

            return {"jsonrpc": "2.0", "id": req_id, "result": result}

        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32603, "message": str(e)},
            }

    def _handle_initialize(self, params: dict) -> dict:
        self._initialized = True
        return {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": self.name, "version": self.version},
            "capabilities": {
                "tools": {"listChanged": True},
                "resources": {"listChanged": True},
                "prompts": {"listChanged": True},
            },
        }

    def _handle_tools_list(self) -> dict:
        return {"tools": self.registry.list_tools()}

    def _handle_tools_call(self, params: dict) -> dict:
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})
        return self.registry.call_tool(tool_name, arguments)

    def run(self, stdin=None, stdout=None) -> None:
        """Run the server in stdio mode (newline-delimited JSON-RPC)."""
        inp = stdin or sys.stdin
        out = stdout or sys.stdout

        for line in inp:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue
            response = self.handle_request(request)
            out.write(json.dumps(response, ensure_ascii=False) + "\n")
            out.flush()
