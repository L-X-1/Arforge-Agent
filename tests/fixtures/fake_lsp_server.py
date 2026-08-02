"""Minimal stdio language server used by protocol integration tests."""

from __future__ import annotations

import json
import sys


def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in {b"\r\n", b"\n"}:
            break
        key, _, value = line.decode("ascii").partition(":")
        headers[key.strip().lower()] = value.strip()
    length = int(headers["content-length"])
    return json.loads(sys.stdin.buffer.read(length))


def send(payload):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


while True:
    message = read_message()
    if message is None:
        break
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}

    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"capabilities": {}}})
    elif method == "shutdown":
        send({"jsonrpc": "2.0", "id": request_id, "result": None})
    elif method == "exit":
        break
    elif method == "textDocument/didOpen":
        uri = params["textDocument"]["uri"]
        send(
            {
                "jsonrpc": "2.0",
                "method": "textDocument/publishDiagnostics",
                "params": {
                    "uri": uri,
                    "diagnostics": [
                        {
                            "severity": 2,
                            "message": "test diagnostic",
                            "range": {
                                "start": {"line": 0, "character": 0},
                                "end": {"line": 0, "character": 3},
                            },
                        }
                    ],
                },
            }
        )
    elif method == "textDocument/definition":
        uri = params["textDocument"]["uri"]
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "uri": uri,
                    "range": {
                        "start": {"line": 0, "character": 4},
                        "end": {"line": 0, "character": 10},
                    },
                },
            }
        )
    elif method == "textDocument/references":
        uri = params["textDocument"]["uri"]
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": [
                    {
                        "uri": uri,
                        "range": {
                            "start": {"line": 0, "character": 4},
                            "end": {"line": 0, "character": 10},
                        },
                    },
                    {
                        "uri": uri,
                        "range": {
                            "start": {"line": 3, "character": 0},
                            "end": {"line": 3, "character": 6},
                        },
                    },
                ],
            }
        )
    elif method == "textDocument/hover":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"contents": {"kind": "markdown", "value": "`target() -> int`"}},
            }
        )
    elif method == "textDocument/documentSymbol":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": [
                    {
                        "name": "target",
                        "kind": 12,
                        "range": {
                            "start": {"line": 0, "character": 0},
                            "end": {"line": 1, "character": 12},
                        },
                        "selectionRange": {
                            "start": {"line": 0, "character": 4},
                            "end": {"line": 0, "character": 10},
                        },
                    }
                ],
            }
        )
    elif method in {"workspace/symbol", "textDocument/implementation"}:
        uri = params.get("textDocument", {}).get("uri", "file:///workspace/sample.py")
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": [
                    {
                        "name": "target",
                        "kind": 12,
                        "location": {
                            "uri": uri,
                            "range": {
                                "start": {"line": 0, "character": 4},
                                "end": {"line": 0, "character": 10},
                            },
                        },
                    }
                ],
            }
        )
    elif method == "textDocument/prepareCallHierarchy":
        uri = params["textDocument"]["uri"]
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": [
                    {
                        "name": "target",
                        "kind": 12,
                        "uri": uri,
                        "range": {
                            "start": {"line": 0, "character": 0},
                            "end": {"line": 1, "character": 12},
                        },
                        "selectionRange": {
                            "start": {"line": 0, "character": 4},
                            "end": {"line": 0, "character": 10},
                        },
                    }
                ],
            }
        )
    elif method == "callHierarchy/incomingCalls":
        item = params["item"]
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": [{"from": {**item, "name": "caller"}, "fromRanges": [item["range"]]}],
            }
        )
    elif method == "callHierarchy/outgoingCalls":
        item = params["item"]
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": [{"to": {**item, "name": "callee"}, "fromRanges": [item["range"]]}],
            }
        )
    elif request_id is not None:
        send({"jsonrpc": "2.0", "id": request_id, "result": None})
