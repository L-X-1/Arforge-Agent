from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import pytest

from arforge.mcp_client_runtime import (
    EnvironmentTokenProvider,
    HTTPMCPClient,
    MCPClientError,
    MCPClientManager,
    OAuthClientCredentialsProvider,
    StdioMCPClient,
    WebSocketMCPClient,
)
from arforge.mcp_ecosystem import MCPResource
from arforge.mcp_http import AuthMiddleware, HTTPTransport
from arforge.mcp_server import MCPServer
from arforge.tool_registry import REGISTRY, ToolMatch


FIXTURE_SERVER = Path(__file__).parent / "fixtures" / "mcp_runtime_server.py"


def _stdio_client(**kwargs) -> StdioMCPClient:
    return StdioMCPClient([sys.executable, str(FIXTURE_SERVER)], **kwargs)


def _content_text(result: dict) -> str:
    return result["content"][0]["text"]


def test_stdio_supports_tools_resources_reconnect_and_bounded_environment(monkeypatch):
    monkeypatch.setenv("ARFORGE_RUNTIME_SECRET", "must-not-leak")
    client = _stdio_client(timeout=2)
    try:
        assert client.initialize()["serverInfo"]["name"] == "runtime-fixture"
        assert {item["name"] for item in client.list_tools()} >= {"echo", "inspect_env"}
        assert _content_text(client.call_tool("echo", {"text": "hello"})) == "hello"
        assert client.list_resources()[0]["uri"] == "arforge://fixture/readme"
        assert client.read_resource("arforge://fixture/readme")["contents"][0]["text"] == "fixture resource"
        assert _content_text(
            client.call_tool("inspect_env", {"name": "ARFORGE_RUNTIME_SECRET"})
        ) == ""
        assert client.reconnect()["serverInfo"]["name"] == "runtime-fixture"
    finally:
        client.close()

    explicit = _stdio_client(timeout=2, env={"ARFORGE_RUNTIME_SECRET": "explicit"})
    try:
        explicit.initialize()
        assert _content_text(
            explicit.call_tool("inspect_env", {"name": "ARFORGE_RUNTIME_SECRET"})
        ) == "explicit"
    finally:
        explicit.close()


def test_stdio_enforces_timeout_and_cancellation():
    client = _stdio_client(timeout=2)
    try:
        client.initialize()
        # Process startup is intentionally outside the 100ms operation bound;
        # otherwise a loaded CI host can fail before the delayed call is tested.
        client.timeout = 0.1
        with pytest.raises(MCPClientError) as timeout:
            client.call_tool("delay", {"seconds": 0.4})
        assert timeout.value.code == "TIMEOUT"
    finally:
        client.close()

    cancelled = threading.Event()
    cancelled.set()
    client = _stdio_client(timeout=1)
    try:
        with pytest.raises(MCPClientError) as error:
            client.request("ping", cancel_event=cancelled)
        assert error.value.code == "CANCELLED"
    finally:
        client.close()


@pytest.fixture
def http_transport():
    server = MCPServer("runtime-http", "1.0")

    @server.tool(description="Echo text.")
    def echo(text: str) -> str:
        return text

    server.resources.register(
        MCPResource("arforge://runtime/info", "info"),
        lambda _uri: "runtime resource",
    )
    transport = HTTPTransport(server, "127.0.0.1", 0)
    transport.setup_defaults()
    transport.middleware.add(AuthMiddleware({"runtime-token"}))
    thread = threading.Thread(target=transport.run, daemon=True)
    thread.start()
    assert transport.wait_until_ready(3)
    port = transport._http_server.server_address[1]
    try:
        yield transport, f"http://127.0.0.1:{port}"
    finally:
        transport.stop()
        thread.join(timeout=3)


@pytest.mark.parametrize("transport_name", ["http", "sse"])
def test_http_and_sse_support_auth_sessions_tools_and_resources(http_transport, transport_name):
    _transport, url = http_transport
    token = EnvironmentTokenProvider("MCP_TEST_TOKEN", {"MCP_TEST_TOKEN": "runtime-token"})
    client = HTTPMCPClient(url, transport=transport_name, token_provider=token, timeout=2)

    assert client.initialize()["serverInfo"]["name"] == "runtime-http"
    assert client.session_id
    assert client.list_tools()[0]["name"] == "echo"
    assert _content_text(client.call_tool("echo", {"text": transport_name})) == transport_name
    assert client.list_resources()[0]["uri"] == "arforge://runtime/info"
    assert client.read_resource("arforge://runtime/info")["contents"][0]["text"] == "runtime resource"
    assert client.reconnect()["serverInfo"]["name"] == "runtime-http"


def test_http_rejects_missing_authentication(http_transport):
    _transport, url = http_transport
    client = HTTPMCPClient(url, timeout=1)
    with pytest.raises(MCPClientError) as error:
        client.initialize()
    assert error.value.code == "CONNECTION_FAILED"


class _Response:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode()
        self.headers = {}

    def read(self, _size=-1):
        body, self._body = self._body, b""
        return body

    def close(self):
        return None


def test_token_providers_do_not_expose_secrets_and_oauth_caches_tokens():
    environment = {"MCP_SECRET": "top-secret"}
    bearer = EnvironmentTokenProvider("MCP_SECRET", environment)
    assert "top-secret" not in repr(bearer)
    assert "top-secret" not in json.dumps(bearer.public())

    calls = []

    def opener(request, timeout):
        calls.append((request, timeout))
        return _Response({"access_token": "oauth-secret", "expires_in": 600})

    oauth = OAuthClientCredentialsProvider(
        "https://auth.example/token?private=query",
        "client-id",
        lambda: "client-secret",
        scopes=["read"],
        opener=opener,
        clock=lambda: 100.0,
    )
    assert oauth.token() == "oauth-secret"
    assert oauth.token() == "oauth-secret"
    assert len(calls) == 1
    public = json.dumps(oauth.public())
    assert "oauth-secret" not in public
    assert "client-secret" not in public
    assert "private=query" not in public
    assert "client-secret" not in repr(oauth)


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/mcp",
        "https://user:password@example.com/mcp",
        "https://example.com/mcp#secret",
    ],
)
def test_remote_url_policy_rejects_unsafe_urls(url):
    with pytest.raises(ValueError):
        HTTPMCPClient(url)


class _FakeWebSocket:
    def __init__(self):
        self.request = {}
        self.closed = False

    def send(self, payload):
        self.request = json.loads(payload)

    def recv(self, timeout=None):
        del timeout
        method = self.request["method"]
        if method == "initialize":
            result = {"serverInfo": {"name": "runtime-ws"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}
        elif method == "tools/call":
            result = {
                "content": [
                    {
                        "type": "text",
                        "text": self.request["params"]["arguments"].get("text", ""),
                    }
                ]
            }
        elif method == "resources/list":
            result = {"resources": [{"uri": "arforge://runtime/ws"}]}
        else:
            result = {"contents": [{"uri": self.request["params"]["uri"], "text": "ws"}]}
        return json.dumps({"jsonrpc": "2.0", "id": self.request["id"], "result": result})

    def close(self):
        self.closed = True


def test_websocket_supports_auth_tools_resources_and_reconnect():
    sockets = []
    calls = []

    def connector(url, **kwargs):
        calls.append((url, kwargs))
        socket = _FakeWebSocket()
        sockets.append(socket)
        return socket

    token = EnvironmentTokenProvider("MCP_WS_TOKEN", {"MCP_WS_TOKEN": "ws-secret"})
    client = WebSocketMCPClient(
        "wss://mcp.example/socket?tenant=public",
        token_provider=token,
        timeout=1,
        connector=connector,
    )
    try:
        assert client.initialize()["serverInfo"]["name"] == "runtime-ws"
        assert client.list_tools()[0]["name"] == "echo"
        assert _content_text(client.call_tool("echo", {"text": "hello"})) == "hello"
        assert client.list_resources()[0]["uri"] == "arforge://runtime/ws"
        assert client.read_resource("arforge://runtime/ws")["contents"][0]["text"] == "ws"
        assert client.reconnect()["serverInfo"]["name"] == "runtime-ws"
        assert sockets[0].closed is True
        assert calls[0][1]["additional_headers"]["Authorization"] == "Bearer ws-secret"
        public = json.dumps(client.public())
        assert "ws-secret" not in public
        assert "tenant=public" not in public
    finally:
        client.close()
    assert sockets[-1].closed is True


@pytest.mark.parametrize(
    "url",
    [
        "ws://example.com/mcp",
        "wss://user:password@example.com/mcp",
        "wss://example.com/mcp#secret",
    ],
)
def test_websocket_url_policy_rejects_unsafe_urls(url):
    with pytest.raises(ValueError):
        WebSocketMCPClient(url, connector=lambda *_args, **_kwargs: _FakeWebSocket())


class _MutableConnection:
    transport = "test"

    def __init__(self):
        self.tools = [
            {
                "name": "echo-value",
                "description": "Echo a value.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                },
            },
            {
                "name": "echo_value",
                "description": "A colliding normalized name.",
                "inputSchema": {"type": "object", "properties": {}},
            },
        ]
        self.calls = []
        self.closed = False

    def initialize(self):
        return {"serverInfo": {"name": "mutable"}}

    def refresh_tools(self):
        return list(self.tools)

    def call_tool(self, name, arguments, *, cancel_event=None):
        self.calls.append((name, arguments, cancel_event))
        return {"content": [{"type": "text", "text": str(arguments.get("value", ""))}]}

    def list_resources(self):
        return []

    def read_resource(self, uri):
        return {"contents": [{"uri": uri, "text": ""}]}

    def reconnect(self):
        return self.initialize()

    def close(self):
        self.closed = True


def test_manager_refreshes_dynamic_tools_preserves_arguments_and_cleans_up():
    manager = MCPClientManager()
    connection = _MutableConnection()
    result = manager.add_connection("runtime", connection)
    names = result["registered"]
    assert len(names) == 2
    assert len(set(names)) == 2

    echo_name = next(name for name in names if REGISTRY.get(name).schema.params)
    execution = REGISTRY.execute(ToolMatch(echo_name, {"value": "kept", "_server": "ignored"}))
    assert execution.success
    assert json.loads(execution.output)["content"][0]["text"] == "kept"
    assert connection.calls[-1][0] == "echo-value"
    assert connection.calls[-1][1]["value"] == "kept"

    connection.tools = [
        {
            "name": "new-tool",
            "description": "New.",
            "inputSchema": {"type": "object", "properties": {}},
        }
    ]
    refresh = manager.refresh_tools("runtime")
    assert refresh["added"] == ["new-tool"]
    assert sorted(refresh["removed"]) == ["echo-value", "echo_value"]
    assert all(REGISTRY.get(name) is None for name in names)

    new_names = refresh["registered"]
    manager.disconnect("runtime")
    assert connection.closed
    assert all(REGISTRY.get(name) is None for name in new_names)


def test_manager_reconnects_dead_stdio_server_before_tool_call():
    manager = MCPClientManager()
    connection = _stdio_client(timeout=2)
    manager.add_connection("dead_before_call", connection)
    try:
        assert connection._proc is not None
        connection._proc.kill()
        connection._proc.wait(timeout=2)

        result = manager.call_tool("dead_before_call", "echo", {"text": "alive"})

        assert _content_text(result) == "alive"
        recovery = manager.list_servers()[0]["recovery"]
        assert recovery["attempts"] == 1
        assert recovery["successes"] == 1
        assert recovery["last_error_code"] == ""
    finally:
        manager.disconnect_all()


def test_manager_recovers_but_does_not_replay_unknown_side_effect_tool():
    manager = MCPClientManager()
    manager.connect_stdio(
        "ambiguous_tool",
        [sys.executable, str(FIXTURE_SERVER)],
        timeout=2,
    )
    try:
        with pytest.raises(MCPClientError) as error:
            manager.call_tool("ambiguous_tool", "crash", {})

        assert error.value.code == "TOOL_RESULT_UNKNOWN"
        assert "not retried" in error.value.message
        assert _content_text(
            manager.call_tool("ambiguous_tool", "echo", {"text": "next call works"})
        ) == "next call works"
        recovery = manager.list_servers()[0]["recovery"]
        assert recovery["attempts"] == 1
        assert recovery["successes"] == 1
    finally:
        manager.disconnect_all()


def test_manager_reconnects_and_retries_idempotent_stdio_tool(tmp_path):
    marker = tmp_path / "crash-once.marker"
    manager = MCPClientManager()
    manager.connect_stdio(
        "idempotent_tool",
        [sys.executable, str(FIXTURE_SERVER)],
        timeout=2,
        env={"MCP_CRASH_ONCE_MARKER": str(marker)},
    )
    try:
        result = manager.call_tool("idempotent_tool", "crash_once", {})

        assert marker.read_text(encoding="utf-8") == "crashed"
        assert _content_text(result) == "recovered"
        recovery = manager.list_servers()[0]["recovery"]
        assert recovery["attempts"] == 1
        assert recovery["successes"] == 1
    finally:
        manager.disconnect_all()
