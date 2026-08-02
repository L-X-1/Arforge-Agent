"""Small stdio JSON-RPC server used by production MCP client tests."""

from __future__ import annotations

import json
import os
import sys
import time


TOOLS = [
    {
        "name": "echo",
        "description": "Echo text.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "inspect_env",
        "description": "Read one environment variable.",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
    },
    {
        "name": "delay",
        "description": "Delay a response.",
        "inputSchema": {
            "type": "object",
            "properties": {"seconds": {"type": "number"}},
            "required": ["seconds"],
        },
    },
    {
        "name": "crash",
        "description": "Terminate before returning a response.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "crash_once",
        "description": "Crash once, then return after reconnect.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"idempotentHint": True},
    },
]


def _result(method: str, params: dict) -> dict:
    if method == "initialize":
        return {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "runtime-fixture", "version": "1.0"},
            "capabilities": {"tools": {}, "resources": {}},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments", {})
        if name == "echo":
            text = str(arguments.get("text", ""))
        elif name == "inspect_env":
            text = os.environ.get(str(arguments.get("name", "")), "")
        elif name == "delay":
            time.sleep(float(arguments.get("seconds", 0)))
            text = "done"
        elif name == "crash":
            os._exit(9)
        elif name == "crash_once":
            marker = os.environ.get("MCP_CRASH_ONCE_MARKER", "")
            if marker and not os.path.exists(marker):
                with open(marker, "w", encoding="utf-8") as handle:
                    handle.write("crashed")
                os._exit(10)
            text = "recovered"
        else:
            return {"isError": True, "content": []}
        return {"content": [{"type": "text", "text": text}]}
    if method == "resources/list":
        return {
            "resources": [
                {
                    "uri": "arforge://fixture/readme",
                    "name": "readme",
                    "mimeType": "text/plain",
                }
            ]
        }
    if method == "resources/read":
        return {
            "contents": [
                {
                    "uri": params.get("uri", ""),
                    "mimeType": "text/plain",
                    "text": "fixture resource",
                }
            ]
        }
    return {}


def main() -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "result": _result(request.get("method", ""), request.get("params", {})),
            }
        except Exception as exc:  # noqa: BLE001 - fixture returns protocol errors
            response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32603, "message": exc.__class__.__name__},
            }
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
