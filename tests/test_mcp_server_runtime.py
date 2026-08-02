"""Contracts for the safe local MCP HTTP/SSE server runtime."""

from __future__ import annotations

import json
import socket
import threading
import time
from urllib.request import Request, urlopen


def test_initialize_returns_session_for_following_http_requests():
    from arforge.mcp_http import HTTPTransport
    from arforge.mcp_server import MCPServer

    server = MCPServer("test", "1.0")
    transport = HTTPTransport(server)
    status, response = transport.handle_http_request(
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).encode(),
    )

    assert status == 200
    session_id = response["_session"]
    assert transport.sessions.get(session_id) is not None

    status, response = transport.handle_http_request(
        json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}).encode(),
        {"X-MCP-Session": session_id},
    )
    assert status == 200
    assert response["_session"] == session_id


def test_http_transport_rejects_invalid_and_oversized_requests():
    from arforge.mcp_http import HTTPTransport
    from arforge.mcp_server import MCPServer

    transport = HTTPTransport(MCPServer("test", "1.0"))

    assert transport.handle_http_request(b"[]")[0] == 400
    assert transport.handle_http_request(b"x" * (1024 * 1024 + 1))[0] == 413


def test_mcp_runtime_registers_read_only_project_tools():
    from arforge.mcp_runtime import create_arforge_mcp_transport

    transport = create_arforge_mcp_transport(auth_token="test-token")
    response = transport.server.handle_request({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})

    assert {item["name"] for item in response["result"]["tools"]} == {"health", "status", "memory_search"}
    allowed, _reason = transport.authorize_headers({"Authorization": "Bearer test-token"})
    denied, _reason = transport.authorize_headers({})
    assert allowed is True
    assert denied is False


def test_server_command_uses_loopback_defaults(monkeypatch):
    import arforge.cli as cli

    seen = {}

    class FakeTransport:
        def run(self):
            seen["ran"] = True

    def fake_create(**kwargs):
        seen.update(kwargs)
        return FakeTransport()

    monkeypatch.setattr("arforge.mcp_runtime.create_arforge_mcp_transport", fake_create)
    assert cli.main(["server", "--port", "9123"]) == 0

    assert seen == {"host": "127.0.0.1", "port": 9123, "auth_token": None, "ran": True}


def test_server_command_rejects_remote_binding_without_explicit_environment(monkeypatch):
    from arforge.cli import main

    monkeypatch.delenv("ARFORGE_ALLOW_REMOTE_SERVER", raising=False)
    monkeypatch.delenv("ARFORGE_MCP_SERVER_TOKEN", raising=False)

    assert main(["server", "--host", "0.0.0.0"]) == 1


def test_mcp_http_service_serves_authenticated_health_and_stops():
    from arforge.mcp_runtime import create_arforge_mcp_transport

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    transport = create_arforge_mcp_transport(port=port, auth_token="integration-token")
    thread = threading.Thread(target=transport.run, daemon=True)
    thread.start()
    request = Request(
        f"http://127.0.0.1:{port}/health",
        headers={"Authorization": "Bearer integration-token"},
    )
    try:
        assert transport.wait_until_ready(timeout=1)
        for _attempt in range(20):
            try:
                with urlopen(request, timeout=0.2) as response:
                    payload = json.loads(response.read())
                break
            except OSError:
                time.sleep(0.03)
        else:
            raise AssertionError("MCP HTTP health endpoint did not start")
        assert payload["status"] == "ok"
        assert payload["server"] == "arforge-agent"
    finally:
        transport.stop()
        thread.join(timeout=2)
    assert not thread.is_alive()
