"""Safe local HTTP server runtime for the Arforge MCP surface."""

from __future__ import annotations

import ipaddress
import json
import os
from pathlib import Path

from arforge.mcp_http import HTTPTransport, create_mcp_http_server
from arforge.paths import get_arforge_home


def is_loopback_host(host: str) -> bool:
    """Return whether a literal host is limited to the local machine."""
    normalized = host.strip().casefold()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def create_arforge_mcp_transport(
    *,
    host: str = "127.0.0.1",
    port: int = 8800,
    auth_token: str | None = None,
) -> HTTPTransport:
    """Create a read-only MCP server backed by existing local project services."""
    transport = create_mcp_http_server(
        "arforge-agent",
        "1.0",
        host=host,
        port=port,
        auth_tokens={auth_token} if auth_token else None,
    )

    @transport.server.tool(description="Return local service health without credentials")
    def health() -> str:
        from arforge.product.service import ProductService

        return json.dumps(ProductService().health({}), ensure_ascii=False)

    @transport.server.tool(description="Return read-only agent status")
    def status() -> str:
        from arforge.status import get_status

        return json.dumps(get_status(), ensure_ascii=False)

    @transport.server.tool(description="Search local memories by text")
    def memory_search(query: str, limit: int = 5) -> str:
        from arforge.memory import query_memories

        bounded_limit = min(max(int(limit), 1), 20)
        return json.dumps(query_memories(query_text=query, limit=bounded_limit), ensure_ascii=False)

    return transport


def server_token_from_environment() -> str:
    """Load a server token without ever placing it in CLI arguments or logs."""
    return os.getenv("ARFORGE_MCP_SERVER_TOKEN", "").strip()


def default_plugin_roots() -> list[Path]:
    """Return the same profile and workspace plugin roots used by the CLI."""
    roots = [get_arforge_home() / "plugins", Path.cwd() / ".arforge" / "plugins"]
    unique: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        resolved = root.expanduser().resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(resolved)
    return unique
