"""Contract tests for MCP Server Framework (T29 M0)."""

import sys
from pathlib import Path


class TestMCPServer:
    """Tests for MCPServer class."""

    def test_initialize(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("test-srv", "0.2.0")

        resp = server.handle_request({"method": "initialize", "id": 1, "params": {}})
        assert resp["jsonrpc"] == "2.0"
        result = resp["result"]
        assert result["protocolVersion"] == "2024-11-05"
        assert result["serverInfo"]["name"] == "test-srv"
        assert result["serverInfo"]["version"] == "0.2.0"

    def test_tools_list_empty(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("test-srv", "0.1.0")

        resp = server.handle_request({"method": "tools/list", "id": 2, "params": {}})
        assert resp["result"]["tools"] == []

    def test_tools_list_with_tools(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("test-srv", "0.1.0")

        @server.tool(description="Echo text")
        def echo(text: str) -> str:
            return text

        @server.tool()
        def add(a: int, b: int) -> str:
            return str(a + b)

        resp = server.handle_request({"method": "tools/list", "id": 3, "params": {}})
        tools = resp["result"]["tools"]
        assert len(tools) == 2

        names = {t["name"] for t in tools}
        assert names == {"echo", "add"}

        for t in tools:
            assert "inputSchema" in t
            assert "properties" in t["inputSchema"]

    def test_tools_call_echo(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("test-srv", "0.1.0")

        @server.tool()
        def echo(text: str) -> str:
            return text

        resp = server.handle_request({
            "method": "tools/call",
            "id": 4,
            "params": {"name": "echo", "arguments": {"text": "hello world"}},
        })
        assert resp["result"]["content"][0]["text"] == "hello world"

    def test_tools_call_add(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("test-srv", "0.1.0")

        @server.tool()
        def add(a: int, b: int) -> str:
            return str(a + b)

        resp = server.handle_request({
            "method": "tools/call",
            "id": 5,
            "params": {"name": "add", "arguments": {"a": 2, "b": 3}},
        })
        assert resp["result"]["content"][0]["text"] == "5"

    def test_tools_call_unknown_tool(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("test-srv", "0.1.0")

        resp = server.handle_request({
            "method": "tools/call",
            "id": 6,
            "params": {"name": "nonexistent", "arguments": {}},
        })
        assert resp["result"]["isError"]

    def test_tools_call_bad_arguments(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("test-srv", "0.1.0")

        @server.tool()
        def add(a: int, b: int) -> str:
            return str(a + b)

        resp = server.handle_request({
            "method": "tools/call",
            "id": 7,
            "params": {"name": "add", "arguments": {"a": "not_a_number", "b": 3}},
        })
        # TypeError should produce isError response
        assert resp["result"]["isError"]

    def test_ping(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("test-srv", "0.1.0")

        resp = server.handle_request({"method": "ping", "id": 8, "params": {}})
        assert "result" in resp
        assert "error" not in resp

    def test_unknown_method(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("test-srv", "0.1.0")

        resp = server.handle_request({"method": "nonexistent_method", "id": 9, "params": {}})
        assert "error" in resp
        assert resp["error"]["code"] == -32601

    def test_input_schema_generation(self):
        from arforge.mcp_server import _build_input_schema

        def my_func(name: str, count: int, active: bool = False) -> str:
            return f"{name}: {count}"

        schema = _build_input_schema(my_func, "test function")
        assert schema["type"] == "object"
        assert "name" in schema["properties"]
        assert "count" in schema["properties"]
        assert "active" in schema["properties"]
        assert schema["properties"]["name"]["type"] == "string"
        assert schema["properties"]["count"]["type"] == "integer"
        assert "name" in schema["required"]
        assert "count" in schema["required"]
        assert "active" not in schema["required"]

    def test_tool_decorator(self):
        from arforge.mcp_server import MCPServer
        server = MCPServer("decorator-test", "0.1.0")

        @server.tool(description="Test tool with description and custom schema")
        def custom(a: int) -> str:
            return str(a * 2)

        assert len(server.registry) == 1

        resp = server.handle_request({
            "method": "tools/call",
            "id": 10,
            "params": {"name": "custom", "arguments": {"a": 7}},
        })
        assert resp["result"]["content"][0]["text"] == "14"


class TestMCPContract:
    """End-to-end contract tests with real stdio process."""

    def test_stdio_roundtrip(self):
        """Launch a real MCPServer subprocess and verify initialize/tools-list/tools-call."""
        from arforge.mcp_client import MCPConnection

        # Build a small test server script
        server_code = '''
import sys, json
from arforge.mcp_server import MCPServer

server = MCPServer("contract-test", "0.1.0")

@server.tool(description="Echo back")
def echo(text: str) -> str:
    return text

@server.tool()
def multiply(x: int, y: int) -> str:
    return str(x * y)

server.run()
'''
        import tempfile
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(server_code)
            server_path = f.name

        try:
            conn = MCPConnection([sys.executable, server_path], timeout=10)

            # Initialize
            info = conn.initialize()
            assert info["serverInfo"]["name"] == "contract-test"

            # List tools
            tools = conn.list_tools()
            tool_names = {t["name"] for t in tools}
            assert tool_names == {"echo", "multiply"}

            # Call echo
            result = conn.call_tool("echo", {"text": "contract-ok"})
            assert result["content"][0]["text"] == "contract-ok"

            # Call multiply
            result = conn.call_tool("multiply", {"x": 6, "y": 7})
            assert result["content"][0]["text"] == "42"

            conn.close()
        finally:
            try:
                Path(server_path).unlink()
            except OSError:
                pass


class TestToolRegistry:
    """Tests for ToolRegistry."""

    def test_register_and_list(self):
        from arforge.mcp_server import ToolRegistry
        registry = ToolRegistry()

        registry.register("hello", lambda: "world", "say hello")
        registry.register("add", lambda a, b: str(a + b), "add numbers",
                          input_schema={"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}}})

        tools = registry.list_tools()
        assert len(tools) == 2
        assert {t["name"] for t in tools} == {"hello", "add"}

    def test_call_tool_success(self):
        from arforge.mcp_server import ToolRegistry
        registry = ToolRegistry()

        registry.register("greet", lambda name: f"Hello, {name}!", "greet someone")

        result = registry.call_tool("greet", {"name": "World"})
        assert result["content"][0]["text"] == "Hello, World!"
        assert not result.get("isError")

    def test_call_tool_unknown(self):
        from arforge.mcp_server import ToolRegistry
        registry = ToolRegistry()

        result = registry.call_tool("nonexistent")
        assert result["isError"]
        assert "Unknown tool" in result["content"][0]["text"]
