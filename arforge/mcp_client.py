"""Minimal JSON-RPC/MCP client primitives."""

from __future__ import annotations

import itertools
import json
import re
from dataclasses import dataclass
from typing import Any


_IDS = itertools.count(1)
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_NESTING_DEPTH = 12
_METHOD_RE = re.compile(r"^[A-Za-z0-9_.\-/]{1,128}$")


def _validate_value(value: Any, depth: int = 0) -> None:
    if depth > MAX_NESTING_DEPTH:
        raise ValueError("MCP payload exceeds maximum nesting depth")
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("MCP object keys must be strings")
        for item in value.values():
            _validate_value(item, depth + 1)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _validate_value(item, depth + 1)
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise TypeError(f"unsupported MCP value type: {type(value).__name__}")


@dataclass
class JsonRpcRequest:
    method: str
    params: dict[str, Any] | None = None
    id: int | None = None

    def to_json(self) -> str:
        if not isinstance(self.method, str) or not _METHOD_RE.fullmatch(self.method):
            raise ValueError("invalid MCP method name")
        if self.params is not None and not isinstance(self.params, dict):
            raise TypeError("MCP params must be an object")
        _validate_value(self.params or {})
        text = json.dumps({"jsonrpc": "2.0", "id": self.id or next(_IDS), "method": self.method, "params": self.params or {}}, ensure_ascii=False)
        if len(text.encode("utf-8")) > MAX_MESSAGE_BYTES:
            raise ValueError("MCP request exceeds maximum message size")
        return text


def make_request(method: str, params: dict[str, Any] = None) -> dict:
    return json.loads(JsonRpcRequest(method, params).to_json())


def parse_response(text: str) -> dict:
    if not isinstance(text, str):
        raise TypeError("MCP response must be text")
    if len(text.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise ValueError("MCP response exceeds maximum message size")
    payload = json.loads(text)
    if not isinstance(payload, dict) or payload.get("jsonrpc") != "2.0":
        raise ValueError("invalid JSON-RPC response")
    if "result" not in payload and "error" not in payload:
        raise ValueError("JSON-RPC response must contain result or error")
    _validate_value(payload)
    return payload


# ---------------------------------------------------------------------------
# v1-3.4：真实 stdio MCP 连接（启动 server 子进程 + 同步 JSON-RPC，行分隔）
# ---------------------------------------------------------------------------


class _LegacyMCPConnection:
    """连接一个 stdio MCP server（子进程），做同步 JSON-RPC（newline-delimited）。

    用法：
        conn = MCPConnection(["python", "-m", "arforge.mcp_test_server"])
        conn.initialize(); tools = conn.list_tools()
        conn.call_tool("echo", {"text": "hi"}); conn.close()
    请求-响应同步配对（MCP stdio 语义：一问一答）。
    """

    def __init__(self, command: list[str], cwd: str | None = None, timeout: int = 15) -> None:
        import subprocess

        self.command = command
        self._proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            cwd=cwd,
            bufsize=1,
        )
        self.timeout = timeout
        self.server_info: dict = {}

    def _send(self, method: str, params: dict | None = None) -> None:
        if self._proc.poll() is not None:
            raise RuntimeError("MCP server process is not running")
        req = make_request(method, params)
        self._proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
        self._proc.stdin.flush()

    def _recv(self) -> dict:
        line = self._proc.stdout.readline()
        if not line:
            err = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"MCP server closed connection. stderr: {err[:500]}")
        return parse_response(line.strip())

    def initialize(self) -> dict:
        self._send(
            "initialize",
            {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "arforge", "version": "1.0"}},
        )
        self.server_info = self._recv().get("result", {})
        return self.server_info

    def list_tools(self) -> list[dict]:
        self._send("tools/list")
        return self._recv().get("result", {}).get("tools", [])

    def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        self._send("tools/call", {"name": name, "arguments": arguments or {}})
        return self._recv().get("result", {})

    def close(self) -> None:
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
            self._proc.terminate()
            self._proc.wait(timeout=3)
        except Exception:  # noqa: BLE001
            try:
                self._proc.kill()
            except Exception:  # noqa: BLE001
                pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# The public name now points at the bounded production implementation. Keeping
# the import here preserves every existing ``from arforge.mcp_client import
# MCPConnection`` caller without retaining the old blocking readline behavior.
from arforge.mcp_client_runtime import StdioMCPClient as MCPConnection  # noqa: E402,F401
