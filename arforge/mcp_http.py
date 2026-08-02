"""MCP Server Framework — M1 (T30): HTTP Transport + Session + Middleware + Plugin.

Extends M0 (MCPServer + ToolRegistry) with:
  - HTTPTransport: serve MCP over HTTP POST with SSE streaming support
  - Session: per-client session tracking with expiration
  - Middleware: auth, logging, metrics hooks
  - Plugin: extension point registry for custom features
"""

from __future__ import annotations

import json
import importlib.util
import logging
import os
import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from arforge.mcp_server import MCPServer

logger = logging.getLogger(__name__)
_SAFE_PLUGIN_NAME = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_SAFE_PLUGIN_TOOL_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_MAX_REQUEST_BYTES = 1024 * 1024
_MAX_PLUGIN_OUTPUT_BYTES = 1024 * 1024
_PLUGIN_TOOL_TIMEOUT_SECONDS = 60


# ====================================================================
# Session
# ====================================================================


@dataclass
class MCPSession:
    """Per-client MCP session with capabilities negotiation."""

    session_id: str
    client_info: dict = field(default_factory=dict)
    protocol_version: str = "2024-11-05"
    capabilities: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)
    metadata: dict = field(default_factory=dict)

    def touch(self) -> None:
        self.last_active = time.time()

    def expired(self, ttl: float = 3600.0) -> bool:
        return (time.time() - self.last_active) > ttl


class SessionManager:
    """Thread-safe session registry with TTL cleanup."""

    def __init__(self, session_ttl: float = 3600.0) -> None:
        self._sessions: dict[str, MCPSession] = {}
        self._ttl = session_ttl
        self._lock = threading.RLock()

    def create(self, client_info: dict | None = None) -> MCPSession:
        sid = str(uuid.uuid4())[:12]
        session = MCPSession(session_id=sid, client_info=client_info or {})
        with self._lock:
            self._sessions[sid] = session
        return session

    def get(self, session_id: str) -> MCPSession | None:
        with self._lock:
            return self._sessions.get(session_id)

    def remove(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def cleanup_expired(self) -> int:
        removed = 0
        with self._lock:
            expired = [sid for sid, s in self._sessions.items() if s.expired(self._ttl)]
            for sid in expired:
                del self._sessions[sid]
                removed += 1
        return removed

    def stats(self) -> dict:
        with self._lock:
            return {
                "active_sessions": len(self._sessions),
                "ttl_seconds": self._ttl,
            }


# ====================================================================
# Middleware
# ====================================================================


class MiddlewareContext:
    """Context passed through the middleware chain."""

    def __init__(self, request: dict, session: MCPSession | None = None) -> None:
        self.request = request
        self.session = session
        self.metadata: dict = {}
        self._aborted = False
        self._abort_reason = ""

    def abort(self, code: int, message: str) -> None:
        self._aborted = True
        self._abort_reason = f"[{code}] {message}"

    @property
    def aborted(self) -> bool:
        return self._aborted

    @property
    def abort_reason(self) -> str:
        return self._abort_reason


class Middleware:
    """Base middleware — override process()."""

    name: str = "base"

    def process(self, ctx: MiddlewareContext) -> MiddlewareContext:
        return ctx


class AuthMiddleware(Middleware):
    """Bearer token authentication middleware."""

    name = "auth"

    def __init__(self, valid_tokens: set[str] | None = None) -> None:
        self._tokens = valid_tokens or set()

    def add_token(self, token: str) -> None:
        self._tokens.add(token)

    def process(self, ctx: MiddlewareContext) -> MiddlewareContext:
        if not self._tokens:
            return ctx  # No auth configured — allow all
        auth_header = ctx.request.get("_headers", {}).get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
            if token in self._tokens:
                return ctx
        ctx.abort(401, "Unauthorized")
        return ctx


class LoggingMiddleware(Middleware):
    """Structured logging for each request."""

    name = "logging"

    def process(self, ctx: MiddlewareContext) -> MiddlewareContext:
        method = ctx.request.get("method", "unknown")
        req_id = ctx.request.get("id", "")
        logger.info("mcp_request method=%s id=%s session=%s",
                     method, req_id,
                     ctx.session.session_id if ctx.session else "none")
        return ctx


class MetricsMiddleware(Middleware):
    """Collect request metrics."""

    name = "metrics"

    def __init__(self) -> None:
        self._counters: dict[str, int] = {}
        self._lock = threading.Lock()

    def process(self, ctx: MiddlewareContext) -> MiddlewareContext:
        method = ctx.request.get("method", "unknown")
        with self._lock:
            self._counters[method] = self._counters.get(method, 0) + 1
        return ctx

    def stats(self) -> dict:
        with self._lock:
            return dict(self._counters)


class MiddlewareChain:
    """Ordered middleware pipeline."""

    def __init__(self) -> None:
        self._middlewares: list[Middleware] = []

    def add(self, mw: Middleware) -> None:
        self._middlewares.append(mw)

    def remove(self, name: str) -> bool:
        before = len(self._middlewares)
        self._middlewares = [m for m in self._middlewares if m.name != name]
        return len(self._middlewares) < before

    def process(self, ctx: MiddlewareContext) -> MiddlewareContext:
        for mw in self._middlewares:
            try:
                ctx = mw.process(ctx)
            except Exception as exc:
                logger.warning("middleware %s failed: %s", mw.name, exc)
            if ctx.aborted:
                break
        return ctx

    def get(self, name: str) -> Middleware | None:
        for mw in self._middlewares:
            if mw.name == name:
                return mw
        return None


# ====================================================================
# Plugin skeleton
# ====================================================================


@dataclass
class PluginManifest:
    name: str
    version: str
    description: str
    hooks: list[str] = field(default_factory=list)
    tools: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class DiscoveredPlugin:
    """Validated plugin metadata that is safe to inspect before code execution."""

    manifest: PluginManifest
    manifest_path: Path
    entrypoint: str
    enabled: bool
    problems: tuple[str, ...] = ()

    def public(self) -> dict[str, Any]:
        return {
            "name": self.manifest.name,
            "version": self.manifest.version,
            "description": self.manifest.description,
            "hooks": list(self.manifest.hooks),
            "tools": [
                {
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": tool["parameters"],
                }
                for tool in self.manifest.tools
            ],
            "manifest_path": str(self.manifest_path),
            "entrypoint": self.entrypoint,
            "enabled": self.enabled,
            "problems": list(self.problems),
        }


class Plugin:
    """Base plugin — override on_load() / on_unload()."""

    manifest: PluginManifest

    def __init__(self, manifest: PluginManifest) -> None:
        self.manifest = manifest
        self._loaded = False

    def on_load(self, server) -> None:
        self._loaded = True

    def on_unload(self) -> None:
        self._loaded = False

    @property
    def loaded(self) -> bool:
        return self._loaded


class DeclarativePlugin(Plugin):
    """A no-import plugin whose tools execute bounded no-shell commands."""

    def __init__(self, manifest: PluginManifest, directory: Path) -> None:
        super().__init__(manifest)
        self.directory = directory.resolve()

    def on_load(self, server) -> None:
        registry = getattr(server, "registry", None)
        if registry is None or not hasattr(registry, "register"):
            raise ValueError("declarative plugins require an MCP tool registry")
        for tool in self.manifest.tools:
            exposed_name = declarative_tool_name(self.manifest.name, tool["name"])

            def handler(_tool=tool, **arguments):
                return run_declarative_plugin_tool(self.directory, _tool, arguments)

            registry.register(
                exposed_name,
                handler,
                tool["description"],
                tool["parameters"],
            )
        super().on_load(server)


def declarative_tool_name(plugin_name: str, tool_name: str) -> str:
    safe_plugin = re.sub(r"[^A-Za-z0-9_]", "_", plugin_name)
    safe_tool = re.sub(r"[^A-Za-z0-9_]", "_", tool_name)
    return f"plugin_{safe_plugin}_{safe_tool}"[:128]


def _validated_declarative_tools(value: Any) -> tuple[list[dict[str, Any]], list[str]]:
    if value is None:
        return [], []
    if not isinstance(value, list) or len(value) > 64:
        return [], ["tools must be an array with at most 64 entries"]
    tools: list[dict[str, Any]] = []
    problems: list[str] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        prefix = f"tools[{index}]"
        if not isinstance(raw, dict):
            problems.append(f"{prefix} must be an object")
            continue
        unexpected = set(raw) - {"name", "description", "command", "parameters"}
        if unexpected:
            problems.append(f"{prefix} contains unsupported fields")
            continue
        name = raw.get("name")
        description = raw.get("description")
        command = raw.get("command")
        parameters = raw.get("parameters", {"type": "object", "properties": {}})
        if not isinstance(name, str) or not _SAFE_PLUGIN_TOOL_NAME.fullmatch(name):
            problems.append(f"{prefix}.name must be short and URL-safe")
            continue
        if name.casefold() in seen:
            problems.append(f"duplicate plugin tool name: {name}")
            continue
        seen.add(name.casefold())
        if not isinstance(description, str) or not description.strip() or len(description) > 2_000:
            problems.append(f"{prefix}.description must be a non-empty string up to 2000 characters")
            continue
        if (
            not isinstance(command, list)
            or not 1 <= len(command) <= 32
            or not all(isinstance(part, str) and part and len(part) <= 1_024 and "\0" not in part for part in command)
        ):
            problems.append(f"{prefix}.command must contain 1 to 32 bounded argument strings")
            continue
        if not isinstance(parameters, dict) or parameters.get("type", "object") != "object":
            problems.append(f"{prefix}.parameters must be an object JSON Schema")
            continue
        properties = parameters.get("properties", {})
        required = parameters.get("required", [])
        if (
            not isinstance(properties, dict)
            or len(properties) > 64
            or not all(
                isinstance(key, str)
                and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}", key)
                and isinstance(schema, dict)
                and schema.get("type", "string") in {"string", "integer", "number", "boolean", "array", "object"}
                for key, schema in properties.items()
            )
            or not isinstance(required, list)
            or not all(isinstance(item, str) and item in properties for item in required)
        ):
            problems.append(f"{prefix}.parameters contains an unsupported property schema")
            continue
        normalized_schema = {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        }
        tools.append(
            {
                "name": name,
                "description": description.strip(),
                "command": list(command),
                "parameters": normalized_schema,
            }
        )
    return tools, problems


def _plugin_command(plugin_directory: Path, command: list[str]) -> list[str]:
    executable = command[0]
    if "/" in executable or "\\" in executable:
        resolved = (plugin_directory / executable).resolve()
        try:
            resolved.relative_to(plugin_directory.resolve())
        except ValueError:
            raise ValueError("plugin command executable escaped its plugin directory") from None
        if not resolved.is_file():
            raise ValueError("plugin command executable does not exist")
        executable = str(resolved)
    elif not re.fullmatch(r"[A-Za-z0-9_.+-]{1,128}", executable):
        raise ValueError("plugin command executable name is invalid")
    return [executable, *command[1:]]


def run_declarative_plugin_tool(
    plugin_directory: Path,
    tool: dict[str, Any],
    arguments: dict[str, Any],
) -> str:
    """Run one explicitly enabled command tool with bounded JSON I/O."""

    payload = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
    if len(payload.encode("utf-8")) > _MAX_REQUEST_BYTES:
        raise ValueError("plugin tool input exceeds 1 MiB")
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
            "LANG",
            "LC_ALL",
        }
    }
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        completed = subprocess.run(
            _plugin_command(plugin_directory, tool["command"]),
            input=payload,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            cwd=plugin_directory,
            env=environment,
            timeout=_PLUGIN_TOOL_TIMEOUT_SECONDS,
            creationflags=creation_flags,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"plugin tool timed out after {_PLUGIN_TOOL_TIMEOUT_SECONDS} seconds") from None
    except OSError as exc:
        raise RuntimeError(f"plugin tool could not start: {exc}") from None
    output = completed.stdout or ""
    error = completed.stderr or ""
    combined_size = len(output.encode("utf-8")) + len(error.encode("utf-8"))
    if combined_size > _MAX_PLUGIN_OUTPUT_BYTES:
        raise RuntimeError("plugin tool output exceeds 1 MiB")
    if completed.returncode != 0:
        detail = " ".join((error or output).split())[:2_000]
        raise RuntimeError(f"plugin tool exited with code {completed.returncode}: {detail}")
    return output.strip()


class PluginRegistry:
    """Discovery and lifecycle for MCP plugins."""

    def __init__(self) -> None:
        self._plugins: dict[str, Plugin] = {}
        self._discovered: dict[str, DiscoveredPlugin] = {}

    def register(self, plugin: Plugin) -> None:
        if not _SAFE_PLUGIN_NAME.fullmatch(plugin.manifest.name):
            raise ValueError("plugin name must be lowercase and URL-safe")
        self._plugins[plugin.manifest.name] = plugin

    def discover(self, roots: list[Path], enabled_overrides: dict[str, bool] | None = None) -> dict[str, Any]:
        """Inspect manifest files without importing plugin code."""
        overrides = enabled_overrides or {}
        candidates: list[DiscoveredPlugin] = []
        for root in roots:
            resolved_root = root.expanduser().resolve()
            if not resolved_root.is_dir():
                continue
            for manifest_path in sorted(resolved_root.glob("*/plugin.json")):
                candidate = self._read_manifest(manifest_path, resolved_root)
                override = overrides.get(str(candidate.manifest_path.resolve()))
                if override is not None:
                    candidate = replace(candidate, enabled=override)
                candidates.append(candidate)
        self._discovered = {candidate.manifest.name: candidate for candidate in candidates}
        return {
            "count": len(candidates),
            "items": [candidate.public() for candidate in candidates],
            "roots": [str(root.expanduser().resolve()) for root in roots],
        }

    def load_discovered(self, server) -> dict[str, Any]:
        """Load discovered, enabled plugins only after manifest validation."""
        loaded: list[str] = []
        failed: dict[str, str] = {}
        for name, candidate in self._discovered.items():
            if not candidate.enabled or candidate.problems:
                continue
            try:
                self.register(self._instantiate(candidate))
                plugin = self._plugins[name]
                plugin.on_load(server)
                loaded.append(name)
            except Exception as exc:  # noqa: BLE001 - plugin exceptions must be isolated
                failed[name] = f"{exc.__class__.__name__}: {exc}"
                logger.warning("plugin %s load failed: %s", name, exc)
        return {"loaded": loaded, "failed": failed}

    def load_all(self, server) -> list[str]:
        loaded = []
        for name, plugin in self._plugins.items():
            try:
                plugin.on_load(server)
                loaded.append(name)
            except Exception as exc:
                logger.warning("plugin %s load failed: %s", name, exc)
        return loaded

    def unload_all(self) -> None:
        for plugin in self._plugins.values():
            try:
                plugin.on_unload()
            except Exception as exc:
                logger.warning("plugin %s unload failed: %s", plugin.manifest.name, exc)

    def list_plugins(self) -> list[dict]:
        return [
            {
                "name": p.manifest.name,
                "version": p.manifest.version,
                "description": p.manifest.description,
                "loaded": p.loaded,
            }
            for p in self._plugins.values()
        ]

    def list_discovered(self) -> list[dict[str, Any]]:
        return [candidate.public() for candidate in self._discovered.values()]

    def discovered_records(self) -> tuple[DiscoveredPlugin, ...]:
        """Return immutable validated records for trusted in-process adapters."""
        return tuple(self._discovered.values())

    @staticmethod
    def _read_manifest(manifest_path: Path, root: Path) -> DiscoveredPlugin:
        fallback_name = manifest_path.parent.name.lower()
        problems: list[str] = []
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            manifest = PluginManifest(fallback_name, "", "")
            return DiscoveredPlugin(manifest, manifest_path, "", False, (f"invalid manifest: {exc}",))
        if not isinstance(payload, dict):
            manifest = PluginManifest(fallback_name, "", "")
            return DiscoveredPlugin(manifest, manifest_path, "", False, ("manifest must be a JSON object",))
        name = payload.get("name", "")
        version = payload.get("version", "")
        description = payload.get("description", "")
        entrypoint = payload.get("entrypoint", "")
        hooks = payload.get("hooks", [])
        tools, tool_problems = _validated_declarative_tools(payload.get("tools"))
        problems.extend(tool_problems)
        for tool in tools:
            try:
                _plugin_command(manifest_path.parent, tool["command"])
            except ValueError as exc:
                problems.append(f"tool {tool['name']}: {exc}")
        enabled = payload.get("enabled", True)
        if not isinstance(name, str) or not _SAFE_PLUGIN_NAME.fullmatch(name):
            problems.append("name must be lowercase and URL-safe")
            name = fallback_name
        if not isinstance(version, str) or not version.strip() or len(version) > 64:
            problems.append("version must be a non-empty string up to 64 characters")
            version = ""
        if not isinstance(description, str) or len(description) > 2_000:
            problems.append("description must be a string up to 2000 characters")
            description = ""
        if not isinstance(hooks, list) or not all(isinstance(item, str) and len(item) <= 128 for item in hooks):
            problems.append("hooks must be an array of short strings")
            hooks = []
        if not isinstance(enabled, bool):
            problems.append("enabled must be a boolean")
            enabled = False
        if not isinstance(entrypoint, str):
            problems.append("entrypoint must be a string")
            entrypoint = ""
        elif entrypoint and not re.fullmatch(r"[A-Za-z0-9_.-]+\.py:[A-Za-z_][A-Za-z0-9_]*", entrypoint):
            problems.append("entrypoint must use relative_file.py:factory format")
            entrypoint = ""
        if not entrypoint and not tools:
            problems.append("manifest must declare an entrypoint or at least one command tool")
        if entrypoint:
            source_name, _factory = entrypoint.split(":", 1)
            source = (manifest_path.parent / source_name).resolve()
            try:
                source.relative_to(manifest_path.parent.resolve())
            except ValueError:
                problems.append("entrypoint must stay inside its plugin directory")
            else:
                try:
                    source.relative_to(root)
                except ValueError:
                    problems.append("entrypoint must stay inside its discovery root")
                if not source.is_file():
                    problems.append("entrypoint file does not exist")
        manifest = PluginManifest(name, version, description, hooks, tools)
        return DiscoveredPlugin(manifest, manifest_path, entrypoint, enabled, tuple(problems))

    @staticmethod
    def _instantiate(candidate: DiscoveredPlugin) -> Plugin:
        if not candidate.entrypoint and candidate.manifest.tools:
            return DeclarativePlugin(candidate.manifest, candidate.manifest_path.parent)
        source_name, factory_name = candidate.entrypoint.split(":", 1)
        source = (candidate.manifest_path.parent / source_name).resolve()
        module_name = f"arforge_external_plugin_{uuid.uuid4().hex}"
        specification = importlib.util.spec_from_file_location(module_name, source)
        if specification is None or specification.loader is None:
            raise ValueError("plugin entrypoint could not be loaded")
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        factory = getattr(module, factory_name, None)
        if not callable(factory):
            raise ValueError("plugin factory is missing or not callable")
        plugin = factory(candidate.manifest)
        if not isinstance(plugin, Plugin):
            raise ValueError("plugin factory must return Plugin")
        if plugin.manifest.name != candidate.manifest.name:
            raise ValueError("plugin manifest name does not match discovered manifest")
        return plugin


# ====================================================================
# HTTP Transport
# ====================================================================


class HTTPTransport:
    """Serve MCP over HTTP POST (with optional SSE support).

    Integrates session management, middleware chain, and plugin registry
    on top of the core MCPServer.
    """

    def __init__(
        self,
        server: MCPServer,
        host: str = "127.0.0.1",
        port: int = 8800,
    ) -> None:
        self.server = server
        self.host = host
        self.port = port
        self.sessions = SessionManager()
        self.middleware = MiddlewareChain()
        self.plugins = PluginRegistry()
        self._running = False
        self._http_server = None
        self._ready_event = threading.Event()

    def setup_defaults(self) -> None:
        """Install default middleware (logging + metrics). Skip auth by default."""
        self.middleware.add(LoggingMiddleware())
        self.middleware.add(MetricsMiddleware())

    def discover_plugins(self, roots: list[Path], enabled_overrides: dict[str, bool] | None = None) -> dict[str, Any]:
        """Discover trusted local plugin manifests without executing their code."""
        return self.plugins.discover(roots, enabled_overrides)

    def load_discovered_plugins(self) -> dict[str, Any]:
        """Explicitly execute validated and enabled plugin factories."""
        return self.plugins.load_discovered(self.server)

    def handle_http_request(
        self, body: bytes, headers: dict[str, str] | None = None
    ) -> tuple[int, dict]:
        """Process an HTTP request and return (status_code, response_dict).

        This is the core HTTP handler — can be used with any HTTP framework.
        """
        headers = headers or {}

        if len(body) > _MAX_REQUEST_BYTES:
            return 413, {"jsonrpc": "2.0", "error": {"code": -32001, "message": "Request too large"}}
        try:
            request = json.loads(body)
        except json.JSONDecodeError:
            return 400, {"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}}
        if not isinstance(request, dict):
            return 400, {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid request"}}

        # Attach headers for middleware
        request["_headers"] = headers

        # Session resolution
        session_id = headers.get("X-MCP-Session", "")
        session = self.sessions.get(session_id) if session_id else None

        # Middleware pipeline
        ctx = MiddlewareContext(request, session)
        ctx = self.middleware.process(ctx)
        if ctx.aborted:
            return 401 if "401" in ctx.abort_reason else 400, {
                "jsonrpc": "2.0",
                "error": {"code": -32000, "message": ctx.abort_reason},
            }

        # Initialize creates a new session
        if request.get("method") == "initialize":
            session = self.sessions.create(request.get("params", {}).get("clientInfo", {}))
            ctx.session = session

        # Delegate to MCPServer
        response = self.server.handle_request(request)

        # Inject session header
        if session:
            session.touch()
            # Private transport metadata; the HTTP handler moves this to a header.
            response["_session"] = session.session_id

        return 200, response

    def authorize_headers(self, headers: dict[str, str] | None = None) -> tuple[bool, str]:
        """Apply the configured middleware to non-RPC endpoints such as SSE."""
        context = MiddlewareContext({"method": "transport.connect", "_headers": headers or {}})
        result = self.middleware.process(context)
        return not result.aborted, result.abort_reason

    def wait_until_ready(self, timeout: float | None = None) -> bool:
        """Wait for the listener to bind successfully."""
        return self._ready_event.wait(timeout)

    def run(self):
        """Start a simple HTTP server (stdlib http.server).

        For production, use this with gunicorn/uvicorn instead.
        """
        import http.server

        transport = self

        class MCPHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                from urllib.parse import parse_qs, urlparse

                parsed_path = urlparse(self.path)
                if parsed_path.path not in {"", "/", "/message"}:
                    self.send_response(404)
                    self.end_headers()
                    return
                try:
                    content_length = int(self.headers.get("Content-Length", 0))
                except ValueError:
                    content_length = -1
                if content_length < 0 or content_length > _MAX_REQUEST_BYTES:
                    self.send_response(413)
                    self.end_headers()
                    return
                body = self.rfile.read(content_length)
                headers = dict(self.headers)
                query_session = parse_qs(parsed_path.query).get("session_id", [""])[0]
                if query_session and "X-MCP-Session" not in headers:
                    headers["X-MCP-Session"] = query_session
                status, response = transport.handle_http_request(body, headers)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                session = response.pop("_session", "")
                if session:
                    self.send_header("X-MCP-Session", session)
                self.end_headers()
                self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))

            # MCP SSE GET endpoint
            def do_GET(self):
                headers = dict(self.headers)
                allowed, reason = transport.authorize_headers(headers)
                if not allowed:
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": reason}).encode("utf-8"))
                    return
                if self.path == "/health":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    payload = {
                        "status": "ok",
                        "server": transport.server.name,
                        "sessions": transport.sessions.stats(),
                    }
                    self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
                    return
                if self.path == "/sse":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    # Create session for SSE
                    session = transport.sessions.create()
                    self.wfile.write(
                        f"event: endpoint\ndata: /message?session_id={session.session_id}\n\n".encode()
                    )
                    self.wfile.flush()
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, format, *args):
                logger.debug("mcp_http %s", format % args)

        self._running = True
        class _ThreadingHTTPServer(http.server.ThreadingHTTPServer):
            allow_reuse_address = True

        try:
            with _ThreadingHTTPServer((self.host, self.port), MCPHandler) as httpd:
                self._http_server = httpd
                self._ready_event.set()
                logger.info("MCP HTTP server listening on %s:%s", self.host, self.port)
                try:
                    httpd.serve_forever()
                except KeyboardInterrupt:
                    pass
        finally:
            self._http_server = None
            self._ready_event.clear()
            self._running = False

    def stop(self) -> None:
        if self._http_server:
            self._http_server.shutdown()
        self._running = False


# ====================================================================
# Convenience builder
# ====================================================================


def create_mcp_http_server(
    name: str,
    version: str,
    host: str = "127.0.0.1",
    port: int = 8800,
    auth_tokens: set[str] | None = None,
) -> HTTPTransport:
    """Create a fully configured MCP HTTP server with defaults.

    Returns HTTPTransport ready to call transport.run().
    """
    server = MCPServer(name, version)
    transport = HTTPTransport(server, host, port)
    transport.setup_defaults()
    if auth_tokens:
        transport.middleware.add(AuthMiddleware(auth_tokens))
    return transport
