"""Production MCP client transports, authentication, resources, and refresh."""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import itertools
import json
import os
import queue
import re
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from arforge.security_guard import sanitize_log_message


MAX_RESPONSE_BYTES = 1024 * 1024
MAX_STDERR_CHARS = 8_000
_SAFE_SERVER_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_SAFE_ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]{0,127}$")
_IDEMPOTENT_METHODS = {
    "ping",
    "tools/list",
    "resources/list",
    "resources/read",
    "prompts/list",
    "prompts/get",
}
_RECOVERABLE_CONNECTION_CODES = {
    "CONNECTION_CLOSED",
    "CONNECTION_FAILED",
    "PROTOCOL_ERROR",
    "TIMEOUT",
}
_REQUEST_IDS = itertools.count(1)
_METHOD_RE = re.compile(r"^[A-Za-z0-9_.\-/]{1,128}$")


def _validate_rpc_value(value: Any, depth: int = 0) -> None:
    if depth > 12:
        raise ValueError("MCP payload exceeds maximum nesting depth")
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("MCP object keys must be strings")
        for item in value.values():
            _validate_rpc_value(item, depth + 1)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _validate_rpc_value(item, depth + 1)
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise TypeError(f"unsupported MCP value type: {type(value).__name__}")


def make_request(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(method, str) or not _METHOD_RE.fullmatch(method):
        raise ValueError("invalid MCP method name")
    if params is not None and not isinstance(params, dict):
        raise TypeError("MCP params must be an object")
    _validate_rpc_value(params or {})
    payload = {
        "jsonrpc": "2.0",
        "id": next(_REQUEST_IDS),
        "method": method,
        "params": params or {},
    }
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_RESPONSE_BYTES:
        raise ValueError("MCP request exceeds maximum message size")
    return payload


def parse_response(text: str) -> dict[str, Any]:
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_RESPONSE_BYTES:
        raise ValueError("MCP response exceeds maximum message size")
    payload = json.loads(text)
    if not isinstance(payload, dict) or payload.get("jsonrpc") != "2.0":
        raise ValueError("invalid JSON-RPC response")
    if "result" not in payload and "error" not in payload:
        raise ValueError("JSON-RPC response must contain result or error")
    _validate_rpc_value(payload)
    return payload


class MCPClientError(RuntimeError):
    """Safe MCP client error with a stable code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = sanitize_log_message(message)


class TokenProvider(Protocol):
    def token(self) -> str: ...

    def public(self) -> dict[str, Any]: ...


@dataclass
class EnvironmentTokenProvider:
    """Resolve a bearer token at request time without persisting its value."""

    environment_variable: str
    environ: dict[str, str] | os._Environ[str] = field(
        default_factory=lambda: os.environ,
        repr=False,
    )

    def __post_init__(self) -> None:
        if not _SAFE_ENV_NAME.fullmatch(self.environment_variable):
            raise ValueError("token environment variable name is invalid")

    def token(self) -> str:
        value = str(self.environ.get(self.environment_variable, "")).strip()
        if not value:
            raise MCPClientError(
                "AUTH_REQUIRED",
                f"token environment variable is not configured: {self.environment_variable}",
            )
        return value

    def public(self) -> dict[str, Any]:
        return {
            "type": "bearer_environment",
            "environment_variable": self.environment_variable,
            "configured": bool(str(self.environ.get(self.environment_variable, "")).strip()),
        }

    def __repr__(self) -> str:
        return (
            "EnvironmentTokenProvider("
            f"environment_variable={self.environment_variable!r}, configured={self.public()['configured']})"
        )


class OAuthClientCredentialsProvider:
    """Bounded OAuth client-credentials provider with in-memory token caching."""

    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret_provider: Callable[[], str],
        *,
        scopes: list[str] | None = None,
        audience: str = "",
        timeout: float = 10.0,
        opener=urlopen,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.token_url = _validate_remote_url(token_url, "token_url")
        self.client_id = str(client_id).strip()
        if not self.client_id or len(self.client_id) > 512:
            raise ValueError("client_id must be a non-empty string up to 512 characters")
        self._secret_provider = client_secret_provider
        self.scopes = [str(item).strip() for item in (scopes or []) if str(item).strip()]
        self.audience = str(audience).strip()
        self.timeout = min(max(float(timeout), 0.1), 60.0)
        self._opener = opener
        self._clock = clock
        self._access_token = ""
        self._expires_at = 0.0
        self._lock = threading.RLock()

    def token(self) -> str:
        with self._lock:
            if self._access_token and self._expires_at - self._clock() > 30:
                return self._access_token
            secret = str(self._secret_provider() or "")
            if not secret:
                raise MCPClientError("AUTH_REQUIRED", "OAuth client secret is not configured")
            form = {"grant_type": "client_credentials"}
            if self.scopes:
                form["scope"] = " ".join(self.scopes)
            if self.audience:
                form["audience"] = self.audience
            basic = base64.b64encode(f"{self.client_id}:{secret}".encode("utf-8")).decode("ascii")
            request = Request(
                self.token_url,
                data=urlencode(form).encode("ascii"),
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Basic {basic}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                method="POST",
            )
            try:
                response = self._opener(request, timeout=self.timeout)
                try:
                    body = _read_bounded(response, MAX_RESPONSE_BYTES)
                finally:
                    response.close()
            except OSError as exc:
                raise MCPClientError(
                    "AUTH_FAILED",
                    f"OAuth token request failed: {exc.__class__.__name__}",
                ) from None
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise MCPClientError("AUTH_FAILED", "OAuth token response is invalid JSON") from None
            token = payload.get("access_token") if isinstance(payload, dict) else None
            if not isinstance(token, str) or not token.strip():
                raise MCPClientError("AUTH_FAILED", "OAuth token response has no access_token")
            expires_in = payload.get("expires_in", 300)
            try:
                lifetime = min(max(int(expires_in), 30), 86_400)
            except (TypeError, ValueError):
                lifetime = 300
            self._access_token = token.strip()
            self._expires_at = self._clock() + lifetime
            return self._access_token

    def public(self) -> dict[str, Any]:
        public_token_url = urlparse(self.token_url)._replace(query="", fragment="").geturl()
        return {
            "type": "oauth_client_credentials",
            "token_url": public_token_url,
            "client_id_configured": True,
            "scopes": list(self.scopes),
            "audience_configured": bool(self.audience),
            "token_cached": bool(self._access_token and self._expires_at > self._clock()),
            "expires_at": self._expires_at if self._access_token else 0,
        }

    def __repr__(self) -> str:
        public_token_url = urlparse(self.token_url)._replace(query="", fragment="").geturl()
        return (
            "OAuthClientCredentialsProvider("
            f"token_url={public_token_url!r}, client_id='<configured>', scopes={self.scopes!r})"
        )


def environment_oauth_provider(
    token_url: str,
    client_id_environment: str,
    client_secret_environment: str,
    *,
    scopes: list[str] | None = None,
    audience: str = "",
    environ: dict[str, str] | os._Environ[str] = os.environ,
) -> OAuthClientCredentialsProvider:
    for name in (client_id_environment, client_secret_environment):
        if not _SAFE_ENV_NAME.fullmatch(name):
            raise ValueError("OAuth environment variable name is invalid")
    client_id = str(environ.get(client_id_environment, "")).strip()
    if not client_id:
        raise MCPClientError(
            "AUTH_REQUIRED",
            f"OAuth client id environment variable is not configured: {client_id_environment}",
        )
    return OAuthClientCredentialsProvider(
        token_url,
        client_id,
        lambda: str(environ.get(client_secret_environment, "")),
        scopes=scopes,
        audience=audience,
    )


def _is_loopback_host(host: str) -> bool:
    if host.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _validate_remote_url(value: str, field: str = "url") -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{field} must be an HTTP or HTTPS URL")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError(f"{field} must not contain credentials or a fragment")
    if parsed.scheme == "http" and not _is_loopback_host(parsed.hostname or ""):
        raise ValueError(f"{field} must use HTTPS for non-loopback hosts")
    return value.strip()


def _validate_websocket_url(value: str, field: str = "url") -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"ws", "wss"} or not parsed.netloc:
        raise ValueError(f"{field} must be a WS or WSS URL")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError(f"{field} must not contain credentials or a fragment")
    if parsed.scheme == "ws" and not _is_loopback_host(parsed.hostname or ""):
        raise ValueError(f"{field} must use WSS for non-loopback hosts")
    return value.strip()


def _minimal_subprocess_environment(extra: dict[str, str] | None = None) -> dict[str, str]:
    allowed = {
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "PYTHONPATH",
        "VIRTUAL_ENV",
        "LANG",
        "LC_ALL",
    }
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() in allowed
    }
    for key, value in (extra or {}).items():
        if not isinstance(key, str) or not isinstance(value, str) or "=" in key or "\x00" in key + value:
            raise ValueError("MCP subprocess environment entries must be safe strings")
        environment[key] = value
    return environment


def _read_bounded(response, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(min(64 * 1024, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > limit:
            raise MCPClientError("RESPONSE_TOO_LARGE", "MCP response exceeds the size limit")
    return b"".join(chunks)


class StdioMCPClient:
    """Bounded no-shell stdio MCP client with real timeout and reconnect."""

    def __init__(
        self,
        command: list[str],
        cwd: str | None = None,
        timeout: float = 15,
        *,
        env: dict[str, str] | None = None,
    ) -> None:
        if (
            not isinstance(command, list)
            or not 1 <= len(command) <= 64
            or not all(isinstance(item, str) and item and "\x00" not in item for item in command)
        ):
            raise ValueError("command must be a non-empty list of safe strings")
        self.command = list(command)
        self.cwd = cwd
        self.timeout = min(max(float(timeout), 0.1), 300.0)
        self.env = dict(env or {})
        self.server_info: dict[str, Any] = {}
        self._proc: subprocess.Popen[str] | None = None
        self._responses: queue.Queue[str | BaseException] = queue.Queue()
        self._stderr: deque[str] = deque(maxlen=80)
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._request_lock = threading.RLock()
        self._closed = False
        self._start()

    def _start(self) -> None:
        startup = None
        creationflags = 0
        if os.name == "nt":
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            self._proc = subprocess.Popen(
                self.command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=self.cwd,
                env=_minimal_subprocess_environment(self.env),
                bufsize=1,
                shell=False,
                startupinfo=startup,
                creationflags=creationflags,
            )
        except OSError as exc:
            raise MCPClientError(
                "START_FAILED",
                f"MCP server process could not start: {exc.__class__.__name__}",
            ) from None
        self._closed = False
        self._responses = queue.Queue()
        self._stderr = deque(maxlen=80)
        proc = self._proc
        responses = self._responses
        stderr = self._stderr
        self._reader = threading.Thread(
            target=self._read_stdout,
            args=(proc, responses),
            daemon=True,
            name="mcp-stdio-reader",
        )
        self._stderr_reader = threading.Thread(
            target=self._read_stderr,
            args=(proc, stderr),
            daemon=True,
            name="mcp-stderr-reader",
        )
        self._reader.start()
        self._stderr_reader.start()

    @staticmethod
    def _read_stdout(
        proc: subprocess.Popen[str],
        responses: queue.Queue[str | BaseException],
    ) -> None:
        assert proc.stdout is not None
        try:
            for line in proc.stdout:
                if len(line.encode("utf-8", errors="replace")) > MAX_RESPONSE_BYTES:
                    responses.put(MCPClientError("RESPONSE_TOO_LARGE", "MCP response exceeds the size limit"))
                    continue
                if line.strip():
                    responses.put(line.strip())
        except BaseException as exc:  # noqa: BLE001 - reader communicates failure
            responses.put(exc)
        finally:
            responses.put(MCPClientError("CONNECTION_CLOSED", "MCP server closed stdout"))

    @staticmethod
    def _read_stderr(proc: subprocess.Popen[str], stderr: deque[str]) -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            cleaned = sanitize_log_message(line.rstrip())
            if cleaned:
                stderr.append(cleaned[:500])

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        if cancel_event is not None and cancel_event.is_set():
            raise MCPClientError("CANCELLED", "MCP request was cancelled")
        with self._request_lock:
            proc = self._proc
            if self._closed or proc is None or proc.poll() is not None:
                raise MCPClientError("CONNECTION_CLOSED", "MCP server process is not running")
            request = make_request(method, params or {})
            assert proc.stdin is not None
            try:
                proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
                proc.stdin.flush()
            except OSError:
                raise MCPClientError("CONNECTION_CLOSED", "MCP request could not be written") from None
            deadline = time.monotonic() + self.timeout
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    raise MCPClientError("CANCELLED", "MCP request was cancelled")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise MCPClientError("TIMEOUT", f"MCP request timed out after {self.timeout:g}s")
                try:
                    item = self._responses.get(timeout=min(remaining, 0.05))
                except queue.Empty:
                    continue
                if isinstance(item, BaseException):
                    if isinstance(item, MCPClientError):
                        raise item
                    raise MCPClientError(
                        "CONNECTION_CLOSED",
                        f"MCP response reader failed: {item.__class__.__name__}",
                    ) from None
                try:
                    response = parse_response(item)
                except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                    raise MCPClientError("PROTOCOL_ERROR", "MCP server returned an invalid response") from None
                if response.get("id") != request.get("id"):
                    continue
                if "error" in response:
                    error = response["error"]
                    message = error.get("message", "MCP server error") if isinstance(error, dict) else str(error)
                    raise MCPClientError("RPC_ERROR", str(message))
                return response.get("result", {})

    def initialize(self) -> dict[str, Any]:
        self.server_info = self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {"roots": {}, "sampling": {}},
                "clientInfo": {"name": "arforge", "version": "1.0"},
            },
        )
        return self.server_info

    def list_tools(self) -> list[dict[str, Any]]:
        return list(self.request("tools/list").get("tools", []))

    def refresh_tools(self) -> list[dict[str, Any]]:
        return self.list_tools()

    def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        return self.request(
            "tools/call",
            {"name": name, "arguments": arguments or {}},
            cancel_event=cancel_event,
        )

    def list_resources(self) -> list[dict[str, Any]]:
        return list(self.request("resources/list").get("resources", []))

    def read_resource(self, uri: str) -> dict[str, Any]:
        return self.request("resources/read", {"uri": uri})

    def reconnect(self) -> dict[str, Any]:
        self.close()
        self._start()
        return self.initialize()

    def close(self) -> None:
        proc = self._proc
        self._closed = True
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
        self._proc = None

    def diagnostics(self) -> dict[str, Any]:
        return {
            "transport": "stdio",
            "running": bool(self._proc and self._proc.poll() is None),
            "stderr_tail": "\n".join(self._stderr)[-MAX_STDERR_CHARS:],
        }

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


class HTTPMCPClient:
    """MCP streamable HTTP or SSE-bootstrap client."""

    def __init__(
        self,
        url: str,
        *,
        transport: str = "http",
        token_provider: TokenProvider | None = None,
        timeout: float = 15.0,
        opener=urlopen,
    ) -> None:
        self.url = _validate_remote_url(url)
        if transport not in {"http", "sse"}:
            raise ValueError("transport must be http or sse")
        self.transport = transport
        self.token_provider = token_provider
        self.timeout = min(max(float(timeout), 0.1), 300.0)
        self._opener = opener
        self.session_id = ""
        self.server_info: dict[str, Any] = {}
        self._endpoint = self.url
        self._lock = threading.RLock()

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.session_id:
            headers["X-MCP-Session"] = self.session_id
        if self.token_provider is not None:
            headers["Authorization"] = f"Bearer {self.token_provider.token()}"
        return headers

    def _connect_sse(self) -> None:
        sse_url = self.url if urlparse(self.url).path.endswith("/sse") else urljoin(self.url.rstrip("/") + "/", "sse")
        headers = {"Accept": "text/event-stream"}
        if self.token_provider is not None:
            headers["Authorization"] = f"Bearer {self.token_provider.token()}"
        request = Request(sse_url, headers=headers, method="GET")
        try:
            response = self._opener(request, timeout=self.timeout)
            try:
                event = ""
                data = ""
                deadline = time.monotonic() + self.timeout
                while time.monotonic() < deadline:
                    line = response.readline(MAX_RESPONSE_BYTES + 1)
                    if len(line) > MAX_RESPONSE_BYTES:
                        raise MCPClientError("RESPONSE_TOO_LARGE", "MCP SSE event exceeds the size limit")
                    if not line:
                        break
                    decoded = line.decode("utf-8", errors="replace").strip()
                    if decoded.startswith("event:"):
                        event = decoded.split(":", 1)[1].strip()
                    elif decoded.startswith("data:"):
                        data = decoded.split(":", 1)[1].strip()
                    elif not decoded and data:
                        break
            finally:
                response.close()
        except OSError as exc:
            raise MCPClientError(
                "CONNECTION_FAILED",
                f"MCP SSE connection failed: {exc.__class__.__name__}",
            ) from None
        if event != "endpoint" or not data:
            raise MCPClientError("PROTOCOL_ERROR", "MCP SSE endpoint event was not received")
        self._endpoint = urljoin(sse_url, data)
        query_session = parse_qs(urlparse(self._endpoint).query).get("session_id", [""])[0]
        if query_session:
            self.session_id = query_session

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        cancel_event: threading.Event | None = None,
        retry: bool = True,
    ) -> dict[str, Any]:
        if cancel_event is not None and cancel_event.is_set():
            raise MCPClientError("CANCELLED", "MCP request was cancelled")
        with self._lock:
            if self.transport == "sse" and self._endpoint == self.url:
                self._connect_sse()
            payload = json.dumps(make_request(method, params or {}), ensure_ascii=False).encode("utf-8")
            request = Request(self._endpoint, data=payload, headers=self._headers(), method="POST")
            try:
                response = self._opener(request, timeout=self.timeout)
                try:
                    session_id = response.headers.get("X-MCP-Session", "")
                    if session_id:
                        self.session_id = session_id
                    body = _read_bounded(response, MAX_RESPONSE_BYTES)
                finally:
                    response.close()
            except OSError as exc:
                if retry and method in _IDEMPOTENT_METHODS:
                    self.session_id = ""
                    self._endpoint = self.url
                    self.initialize()
                    return self.request(method, params, cancel_event=cancel_event, retry=False)
                raise MCPClientError(
                    "CONNECTION_FAILED",
                    f"MCP HTTP request failed: {exc.__class__.__name__}",
                ) from None
            if cancel_event is not None and cancel_event.is_set():
                raise MCPClientError("CANCELLED", "MCP request was cancelled")
            try:
                response_payload = parse_response(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                raise MCPClientError("PROTOCOL_ERROR", "MCP server returned an invalid response") from None
            if "error" in response_payload:
                error = response_payload["error"]
                message = error.get("message", "MCP server error") if isinstance(error, dict) else str(error)
                raise MCPClientError("RPC_ERROR", str(message))
            return response_payload.get("result", {})

    def initialize(self) -> dict[str, Any]:
        if self.transport == "sse" and self._endpoint == self.url:
            self._connect_sse()
        self.server_info = self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {"roots": {}, "sampling": {}},
                "clientInfo": {"name": "arforge", "version": "1.0"},
            },
            retry=False,
        )
        return self.server_info

    def list_tools(self) -> list[dict[str, Any]]:
        return list(self.request("tools/list").get("tools", []))

    def refresh_tools(self) -> list[dict[str, Any]]:
        return self.list_tools()

    def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        return self.request(
            "tools/call",
            {"name": name, "arguments": arguments or {}},
            cancel_event=cancel_event,
            retry=False,
        )

    def list_resources(self) -> list[dict[str, Any]]:
        return list(self.request("resources/list").get("resources", []))

    def read_resource(self, uri: str) -> dict[str, Any]:
        return self.request("resources/read", {"uri": uri})

    def reconnect(self) -> dict[str, Any]:
        self.session_id = ""
        self._endpoint = self.url
        return self.initialize()

    def close(self) -> None:
        self.session_id = ""
        self._endpoint = self.url

    def public(self) -> dict[str, Any]:
        parsed = urlparse(self.url)
        public_url = parsed._replace(query="", fragment="").geturl()
        return {
            "transport": self.transport,
            "url": public_url,
            "session_active": bool(self.session_id),
            "authentication": self.token_provider.public() if self.token_provider else {"type": "none"},
        }


class WebSocketMCPClient:
    """Bounded synchronous MCP client for generic WS/WSS transports."""

    transport = "websocket"

    def __init__(
        self,
        url: str,
        *,
        token_provider: TokenProvider | None = None,
        timeout: float = 15.0,
        connector=None,
    ) -> None:
        self.url = _validate_websocket_url(url)
        self.token_provider = token_provider
        self.timeout = min(max(float(timeout), 0.1), 300.0)
        self.server_info: dict[str, Any] = {}
        self._connector = connector
        self._connection = None
        self._request_lock = threading.Lock()
        self._closed = False
        self._connect()

    def _connect(self) -> None:
        connector = self._connector
        if connector is None:
            try:
                from websockets.sync.client import connect as connector
            except ImportError:
                raise MCPClientError(
                    "DEPENDENCY_MISSING",
                    "WebSocket MCP transport requires the websockets package",
                ) from None
        headers = {}
        if self.token_provider is not None:
            headers["Authorization"] = f"Bearer {self.token_provider.token()}"
        try:
            self._connection = connector(
                self.url,
                additional_headers=headers or None,
                open_timeout=self.timeout,
                close_timeout=min(self.timeout, 5.0),
                max_size=MAX_RESPONSE_BYTES,
            )
        except Exception as exc:  # noqa: BLE001 - normalized transport boundary
            raise MCPClientError(
                "CONNECTION_FAILED",
                f"MCP WebSocket connection failed: {exc.__class__.__name__}",
            ) from None
        self._closed = False

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        cancel_event: threading.Event | None = None,
        retry: bool = True,
    ) -> dict[str, Any]:
        if cancel_event is not None and cancel_event.is_set():
            raise MCPClientError("CANCELLED", "MCP request was cancelled")
        with self._request_lock:
            if self._closed or self._connection is None:
                raise MCPClientError("CONNECTION_CLOSED", "MCP WebSocket is not connected")
            request = make_request(method, params or {})
            try:
                self._connection.send(json.dumps(request, ensure_ascii=False))
                deadline = time.monotonic() + self.timeout
                while True:
                    if cancel_event is not None and cancel_event.is_set():
                        raise MCPClientError("CANCELLED", "MCP request was cancelled")
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise MCPClientError(
                            "TIMEOUT",
                            f"MCP request timed out after {self.timeout:g}s",
                        )
                    try:
                        raw = self._connection.recv(timeout=min(remaining, 0.05))
                    except TimeoutError:
                        continue
                    if isinstance(raw, bytes):
                        if len(raw) > MAX_RESPONSE_BYTES:
                            raise MCPClientError(
                                "RESPONSE_TOO_LARGE",
                                "MCP response exceeds the size limit",
                            )
                        raw = raw.decode("utf-8")
                    if not isinstance(raw, str):
                        raise MCPClientError(
                            "PROTOCOL_ERROR",
                            "MCP WebSocket returned a non-text response",
                        )
                    try:
                        response = parse_response(raw)
                    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                        raise MCPClientError(
                            "PROTOCOL_ERROR",
                            "MCP server returned an invalid response",
                        ) from None
                    if response.get("id") != request["id"]:
                        continue
                    if "error" in response:
                        error = response["error"]
                        message = (
                            error.get("message", "MCP server error")
                            if isinstance(error, dict)
                            else str(error)
                        )
                        raise MCPClientError("RPC_ERROR", str(message))
                    return response.get("result", {})
            except MCPClientError:
                raise
            except Exception as exc:  # noqa: BLE001 - normalized transport boundary
                if retry and method in _IDEMPOTENT_METHODS:
                    self._reconnect_unlocked()
                    return self.request(
                        method,
                        params,
                        cancel_event=cancel_event,
                        retry=False,
                    )
                raise MCPClientError(
                    "CONNECTION_FAILED",
                    f"MCP WebSocket request failed: {exc.__class__.__name__}",
                ) from None

    def initialize(self) -> dict[str, Any]:
        self.server_info = self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {"roots": {}, "sampling": {}},
                "clientInfo": {"name": "arforge", "version": "1.0"},
            },
            retry=False,
        )
        return self.server_info

    def list_tools(self) -> list[dict[str, Any]]:
        return list(self.request("tools/list").get("tools", []))

    def refresh_tools(self) -> list[dict[str, Any]]:
        return self.list_tools()

    def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        return self.request(
            "tools/call",
            {"name": name, "arguments": arguments or {}},
            cancel_event=cancel_event,
            retry=False,
        )

    def list_resources(self) -> list[dict[str, Any]]:
        return list(self.request("resources/list").get("resources", []))

    def read_resource(self, uri: str) -> dict[str, Any]:
        return self.request("resources/read", {"uri": uri})

    def _reconnect_unlocked(self) -> None:
        connection, self._connection = self._connection, None
        if connection is not None:
            try:
                connection.close()
            except Exception:  # noqa: BLE001 - best-effort transport cleanup
                pass
        self._connect()

    def reconnect(self) -> dict[str, Any]:
        with self._request_lock:
            self._reconnect_unlocked()
        return self.initialize()

    def close(self) -> None:
        connection, self._connection = self._connection, None
        self._closed = True
        if connection is not None:
            try:
                connection.close()
            except Exception:  # noqa: BLE001 - best-effort transport cleanup
                pass

    def public(self) -> dict[str, Any]:
        parsed = urlparse(self.url)
        return {
            "transport": self.transport,
            "url": parsed._replace(query="", fragment="").geturl(),
            "connected": bool(self._connection is not None and not self._closed),
            "authentication": (
                self.token_provider.public()
                if self.token_provider
                else {"type": "none"}
            ),
        }


def _json_type(value: Any) -> str:
    return {
        "integer": "int",
        "number": "float",
        "boolean": "bool",
        "array": "array",
        "object": "object",
    }.get(str(value), "string")


class MCPClientManager:
    """Own client connections and synchronize external tools into Arforge."""

    def __init__(self) -> None:
        self._servers: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()

    @staticmethod
    def _name(name: str) -> str:
        normalized = str(name).strip().casefold()
        if not _SAFE_SERVER_NAME.fullmatch(normalized):
            raise ValueError("server name must be lowercase and contain only letters, digits, _ or -")
        return normalized

    def add_connection(self, name: str, connection, *, initialize: bool = True) -> dict[str, Any]:
        server_name = self._name(name)
        with self._lock:
            if server_name in self._servers:
                raise MCPClientError("SERVER_EXISTS", f"MCP server already exists: {server_name}")
            info = connection.initialize() if initialize else getattr(connection, "server_info", {})
            self._servers[server_name] = {
                "connection": connection,
                "server_info": info or {},
                "tools": {},
                "registered": set(),
                "recovery": {
                    "attempts": 0,
                    "successes": 0,
                    "last_reason": "",
                    "last_error_code": "",
                },
            }
        try:
            refresh = self.refresh_tools(server_name)
        except Exception:
            with self._lock:
                self._servers.pop(server_name, None)
            raise
        return {"name": server_name, "server_info": info or {}, **refresh}

    def connect_stdio(
        self,
        name: str,
        command: list[str],
        *,
        cwd: str | None = None,
        timeout: float = 15.0,
        env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        connection = StdioMCPClient(command, cwd=cwd, timeout=timeout, env=env)
        try:
            return self.add_connection(name, connection)
        except Exception:
            connection.close()
            raise

    def connect_http(
        self,
        name: str,
        url: str,
        *,
        transport: str = "http",
        token_provider: TokenProvider | None = None,
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        connection = HTTPMCPClient(
            url,
            transport=transport,
            token_provider=token_provider,
            timeout=timeout,
        )
        try:
            return self.add_connection(name, connection)
        except Exception:
            connection.close()
            raise

    def connect_websocket(
        self,
        name: str,
        url: str,
        *,
        token_provider: TokenProvider | None = None,
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        connection = WebSocketMCPClient(
            url,
            token_provider=token_provider,
            timeout=timeout,
        )
        try:
            return self.add_connection(name, connection)
        except Exception:
            connection.close()
            raise

    def _server(self, name: str) -> dict[str, Any]:
        server_name = self._name(name)
        server = self._servers.get(server_name)
        if server is None:
            raise MCPClientError("SERVER_NOT_FOUND", f"MCP server not found: {server_name}")
        return server

    @staticmethod
    def _connection_is_down(connection) -> bool:
        diagnostics = getattr(connection, "diagnostics", None)
        if not callable(diagnostics):
            return False
        try:
            public = diagnostics()
        except Exception:  # noqa: BLE001 - diagnostics must not break calls
            return False
        return isinstance(public, dict) and public.get("running") is False

    def _recover_server(self, server_name: str, *, reason: str) -> dict[str, Any]:
        """Reconnect one server and refresh its dynamic tool registrations."""
        with self._lock:
            server = self._server(server_name)
            recovery = server["recovery"]
            recovery["attempts"] += 1
            recovery["last_reason"] = sanitize_log_message(reason)[:160]
            connection = server["connection"]
        try:
            info = connection.reconnect()
            with self._lock:
                server = self._server(server_name)
                server["server_info"] = info or {}
            refreshed = self.refresh_tools(server_name)
        except Exception as exc:  # noqa: BLE001 - normalize recovery boundary
            code = getattr(exc, "code", exc.__class__.__name__)
            with self._lock:
                server = self._server(server_name)
                server["recovery"]["last_error_code"] = str(code)[:80]
            raise MCPClientError(
                "RECOVERY_FAILED",
                f"MCP server recovery failed: {code}",
            ) from None
        with self._lock:
            recovery = self._server(server_name)["recovery"]
            recovery["successes"] += 1
            recovery["last_error_code"] = ""
        return {"server_info": info or {}, **refreshed}

    def _ready_connection(self, server_name: str):
        with self._lock:
            connection = self._server(server_name)["connection"]
        if self._connection_is_down(connection):
            self._recover_server(server_name, reason="preflight connection closed")
            with self._lock:
                connection = self._server(server_name)["connection"]
        return connection

    def refresh_tools(self, name: str) -> dict[str, Any]:
        server_name = self._name(name)
        with self._lock:
            server = self._server(server_name)
            tools = server["connection"].refresh_tools()
            normalized = {
                str(item.get("name")): item
                for item in tools
                if isinstance(item, dict) and isinstance(item.get("name"), str)
            }
            previous = server["tools"]
            added = sorted(set(normalized) - set(previous))
            removed = sorted(set(previous) - set(normalized))
            changed = sorted(
                key
                for key in set(previous) & set(normalized)
                if json.dumps(previous[key], sort_keys=True) != json.dumps(normalized[key], sort_keys=True)
            )
            definitions = self._build_tool_definitions(server_name, server, normalized)
            self._unregister_tools(server)
            server["tools"] = normalized
            self._register_tools(server, definitions)
            return {
                "tool_count": len(normalized),
                "added": added,
                "removed": removed,
                "changed": changed,
                "registered": sorted(server["registered"]),
            }

    def _build_tool_definitions(
        self,
        server_name: str,
        server: dict[str, Any],
        tools: dict[str, dict[str, Any]],
    ) -> list[Any]:
        from arforge.tool_registry import REGISTRY, ParamSchema, ToolDefinition, ToolSchema

        definitions: list[ToolDefinition] = []
        reserved = set(REGISTRY.tools) - set(server["registered"])
        for tool_name, definition in tools.items():
            safe_tool = re.sub(r"[^A-Za-z0-9_]", "_", tool_name)
            base_name = f"mcp_{server_name}_{safe_tool}"[:128]
            full_name = base_name
            if full_name in reserved:
                digest = hashlib.sha256(f"{server_name}\0{tool_name}".encode()).hexdigest()[:10]
                full_name = f"{base_name[:117]}_{digest}"
            if full_name in reserved:
                raise MCPClientError(
                    "TOOL_NAME_CONFLICT",
                    f"MCP tool registration conflicts with an existing tool: {full_name}",
                )
            reserved.add(full_name)
            schema = definition.get("inputSchema") or {}
            properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
            required = set(schema.get("required", [])) if isinstance(schema, dict) else set()
            params = []
            if isinstance(properties, dict):
                for param_name, raw_schema in properties.items():
                    if not isinstance(param_name, str) or not isinstance(raw_schema, dict):
                        continue
                    params.append(
                        ParamSchema(
                            param_name,
                            _json_type(raw_schema.get("type")),
                            str(raw_schema.get("description", "")),
                            required=param_name in required,
                            json_schema=dict(raw_schema),
                        )
                    )

            def make_execute(target_server: str, target_tool: str):
                def execute(**kwargs):
                    return json.dumps(
                        self.call_tool(target_server, target_tool, kwargs),
                        ensure_ascii=False,
                    )

                return execute

            definitions.append(
                ToolDefinition(
                    name=full_name,
                    description=str(definition.get("description", "")) or f"MCP tool {tool_name}",
                    schema=ToolSchema(
                        name=full_name,
                        description=str(definition.get("description", "")),
                        params=params,
                        risk_level="medium",
                        category="network",
                        should_defer=True,
                    ),
                    execute_fn=make_execute(server_name, tool_name),
                    source=f"mcp:{server_name}",
                    search_hint=f"{server_name} external MCP {tool_name}",
                )
            )
        return definitions

    @staticmethod
    def _register_tools(server: dict[str, Any], definitions: list[Any]) -> None:
        from arforge.tool_registry import REGISTRY

        for definition in definitions:
            REGISTRY.register(definition)
            full_name = definition.name
            server["registered"].add(full_name)

    @staticmethod
    def _unregister_tools(server: dict[str, Any]) -> None:
        from arforge.tool_registry import REGISTRY

        for name in server["registered"]:
            REGISTRY.tools.pop(name, None)
        server["registered"] = set()

    def call_tool(
        self,
        server_name: str,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        normalized_server = self._name(server_name)
        with self._lock:
            server = self._server(normalized_server)
            if tool_name not in server["tools"]:
                raise MCPClientError("TOOL_NOT_FOUND", f"MCP tool not found: {tool_name}")
            definition = server["tools"][tool_name]
        connection = self._ready_connection(normalized_server)
        try:
            return connection.call_tool(
                tool_name,
                arguments or {},
                cancel_event=cancel_event,
            )
        except MCPClientError as exc:
            if exc.code not in _RECOVERABLE_CONNECTION_CODES:
                raise
            self._recover_server(normalized_server, reason=f"tool call failed: {exc.code}")
            annotations = definition.get("annotations", {})
            safe_retry = isinstance(annotations, dict) and (
                annotations.get("readOnlyHint") is True
                or annotations.get("idempotentHint") is True
            )
            if safe_retry:
                connection = self._ready_connection(normalized_server)
                return connection.call_tool(
                    tool_name,
                    arguments or {},
                    cancel_event=cancel_event,
                )
            raise MCPClientError(
                "TOOL_RESULT_UNKNOWN",
                "MCP connection recovered, but the tool was not retried because "
                "its execution may have side effects; inspect remote state before retrying",
            ) from None

    def list_resources(self, server_name: str) -> list[dict[str, Any]]:
        normalized_server = self._name(server_name)
        connection = self._ready_connection(normalized_server)
        try:
            return connection.list_resources()
        except MCPClientError as exc:
            if exc.code not in _RECOVERABLE_CONNECTION_CODES:
                raise
            self._recover_server(normalized_server, reason=f"resource list failed: {exc.code}")
            return self._ready_connection(normalized_server).list_resources()

    def read_resource(self, server_name: str, uri: str) -> dict[str, Any]:
        normalized_server = self._name(server_name)
        connection = self._ready_connection(normalized_server)
        try:
            return connection.read_resource(uri)
        except MCPClientError as exc:
            if exc.code not in _RECOVERABLE_CONNECTION_CODES:
                raise
            self._recover_server(normalized_server, reason=f"resource read failed: {exc.code}")
            return self._ready_connection(normalized_server).read_resource(uri)

    def reconnect(self, server_name: str) -> dict[str, Any]:
        with self._lock:
            server = self._server(server_name)
            info = server["connection"].reconnect()
            server["server_info"] = info
        return {"server_info": info, **self.refresh_tools(server_name)}

    def list_servers(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {
                    "name": name,
                    "server_info": dict(server["server_info"]),
                    "tool_count": len(server["tools"]),
                    "registered_tools": sorted(server["registered"]),
                    "transport": getattr(server["connection"], "transport", "stdio"),
                    "recovery": dict(server["recovery"]),
                }
                for name, server in sorted(self._servers.items())
            ]

    def disconnect(self, name: str) -> None:
        server_name = self._name(name)
        with self._lock:
            server = self._servers.pop(server_name, None)
            if server is None:
                return
            self._unregister_tools(server)
        server["connection"].close()

    def disconnect_all(self) -> None:
        with self._lock:
            names = list(self._servers)
        for name in names:
            self.disconnect(name)


_manager = MCPClientManager()


def get_mcp_client_manager() -> MCPClientManager:
    return _manager


__all__ = [
    "EnvironmentTokenProvider",
    "HTTPMCPClient",
    "MCPClientError",
    "MCPClientManager",
    "OAuthClientCredentialsProvider",
    "StdioMCPClient",
    "WebSocketMCPClient",
    "environment_oauth_provider",
    "get_mcp_client_manager",
]
