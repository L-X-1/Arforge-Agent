"""Tests for T30: MCP M1 — HTTP Transport + Session + Middleware + Plugin."""

from __future__ import annotations

import json
import time

import pytest

from arforge.mcp_server import MCPServer
from arforge.mcp_http import (
    HTTPTransport,
    AuthMiddleware,
    LoggingMiddleware,
    MetricsMiddleware,
    MiddlewareChain,
    MiddlewareContext,
    SessionManager,
    Plugin,
    PluginManifest,
    PluginRegistry,
    create_mcp_http_server,
)


@pytest.fixture
def server():
    srv = MCPServer("test-m1", "0.1.0")

    @srv.tool()
    def echo(text: str) -> str:
        return text

    @srv.tool()
    def add(a: int, b: int) -> str:
        return str(a + b)

    return srv


class TestSessionManager:
    def test_create_and_get_session(self):
        sm = SessionManager(session_ttl=3600)
        s = sm.create({"name": "test-client"})
        assert s.session_id
        assert s.client_info["name"] == "test-client"

        found = sm.get(s.session_id)
        assert found is not None
        assert found.session_id == s.session_id

    def test_session_expiry(self):
        sm = SessionManager(session_ttl=0.01)  # 10ms TTL
        s = sm.create()
        time.sleep(0.02)
        assert s.expired(0.01)
        removed = sm.cleanup_expired()
        assert removed == 1
        assert sm.get(s.session_id) is None

    def test_remove_session(self):
        sm = SessionManager()
        s = sm.create()
        sm.remove(s.session_id)
        assert sm.get(s.session_id) is None

    def test_stats(self):
        sm = SessionManager()
        sm.create()
        sm.create()
        stats = sm.stats()
        assert stats["active_sessions"] == 2


class TestMiddleware:
    def test_auth_allows_when_no_tokens(self):
        auth = AuthMiddleware()
        ctx = MiddlewareContext({"_headers": {}}, None)
        result = auth.process(ctx)
        assert not result.aborted

    def test_auth_blocks_invalid_token(self):
        auth = AuthMiddleware({"secret123"})
        ctx = MiddlewareContext({"_headers": {"Authorization": "Bearer wrong"}}, None)
        result = auth.process(ctx)
        assert result.aborted

    def test_auth_allows_valid_token(self):
        auth = AuthMiddleware({"secret123"})
        ctx = MiddlewareContext({"_headers": {"Authorization": "Bearer secret123"}}, None)
        result = auth.process(ctx)
        assert not result.aborted

    def test_metrics_counts_requests(self):
        metrics = MetricsMiddleware()
        metrics.process(MiddlewareContext({"method": "tools/list"}, None))
        metrics.process(MiddlewareContext({"method": "tools/list"}, None))
        metrics.process(MiddlewareContext({"method": "tools/call"}, None))
        stats = metrics.stats()
        assert stats["tools/list"] == 2
        assert stats["tools/call"] == 1

    def test_chain_executes_in_order(self):
        chain = MiddlewareChain()
        chain.add(AuthMiddleware({"tok"}))
        chain.add(MetricsMiddleware())

        # Valid auth
        ctx = MiddlewareContext(
            {"method": "test", "_headers": {"Authorization": "Bearer tok"}}, None
        )
        result = chain.process(ctx)
        assert not result.aborted

    def test_chain_aborts_on_auth_failure(self):
        chain = MiddlewareChain()
        chain.add(AuthMiddleware({"tok"}))
        chain.add(LoggingMiddleware())

        ctx = MiddlewareContext(
            {"method": "test", "_headers": {"Authorization": "Bearer bad"}}, None
        )
        result = chain.process(ctx)
        assert result.aborted


class TestPlugin:
    def test_plugin_load_unload(self):
        manifest = PluginManifest("test-plugin", "0.1", "A test plugin", ["post_tool_use"])
        plugin = Plugin(manifest)
        assert not plugin.loaded

        plugin.on_load(None)
        assert plugin.loaded

        plugin.on_unload()
        assert not plugin.loaded

    def test_registry_loads_all_plugins(self):
        registry = PluginRegistry()
        registry.register(Plugin(PluginManifest("p1", "1.0", "First")))
        registry.register(Plugin(PluginManifest("p2", "1.0", "Second")))
        loaded = registry.load_all(None)
        assert len(loaded) == 2

    def test_registry_lists_plugins(self):
        registry = PluginRegistry()
        registry.register(Plugin(PluginManifest("p1", "1.0", "First")))
        plugins = registry.list_plugins()
        assert len(plugins) == 1
        assert plugins[0]["name"] == "p1"


class TestHTTPTransport:
    def test_create_and_configure(self, server):
        transport = HTTPTransport(server, "127.0.0.1", 18800)
        transport.setup_defaults()
        assert transport.sessions is not None
        assert transport.middleware is not None
        assert transport.plugins is not None

    def test_handle_initialize_creates_session(self, server):
        transport = HTTPTransport(server, "127.0.0.1", 18801)
        transport.setup_defaults()

        status, response = transport.handle_http_request(
            json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"clientInfo": {"name": "test"}},
            }).encode(),
            {},
        )
        assert status == 200
        assert response["result"]["serverInfo"]["name"] == "test-m1"

    def test_handle_tools_list(self, server):
        transport = HTTPTransport(server, "127.0.0.1", 18802)
        transport.setup_defaults()

        # Initialize first
        transport.handle_http_request(
            json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {},
            }).encode(),
            {},
        )

        status, response = transport.handle_http_request(
            json.dumps({
                "jsonrpc": "2.0", "id": 2, "method": "tools/list",
            }).encode(),
            {},
        )
        assert status == 200
        tools = response["result"]["tools"]
        assert len(tools) == 2

    def test_handle_tools_call(self, server):
        transport = HTTPTransport(server, "127.0.0.1", 18803)
        transport.setup_defaults()

        transport.handle_http_request(
            json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {},
            }).encode(),
            {},
        )

        status, response = transport.handle_http_request(
            json.dumps({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": "add", "arguments": {"a": 3, "b": 4}},
            }).encode(),
            {},
        )
        assert status == 200
        assert response["result"]["content"][0]["text"] == "7"

    def test_auth_blocks_unauthenticated(self, server):
        transport = HTTPTransport(server, "127.0.0.1", 18804)
        transport.setup_defaults()
        transport.middleware.add(AuthMiddleware({"my-token"}))

        status, response = transport.handle_http_request(
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}).encode(),
            {"Authorization": "Bearer wrong-token"},
        )
        assert status == 401

    def test_auth_allows_authenticated(self, server):
        transport = HTTPTransport(server, "127.0.0.1", 18805)
        transport.setup_defaults()
        transport.middleware.add(AuthMiddleware({"my-token"}))

        status, response = transport.handle_http_request(
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}).encode(),
            {"Authorization": "Bearer my-token"},
        )
        assert status == 200

    def test_parse_error(self, server):
        transport = HTTPTransport(server, "127.0.0.1", 18806)
        transport.setup_defaults()

        status, response = transport.handle_http_request(b"not json", {})
        assert status == 400

    def test_convenience_builder(self):
        transport = create_mcp_http_server("builder", "1.0", auth_tokens={"key1"})
        assert transport.server.name == "builder"
        assert transport.host == "127.0.0.1"
        assert transport.port == 8800
