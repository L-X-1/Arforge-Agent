"""Bounded Language Server Protocol runtime with local-index fallback."""

from __future__ import annotations

import atexit
import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


MAX_MESSAGE_BYTES = 10 * 1024 * 1024
MAX_FILE_BYTES = 10 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 8.0
OPERATIONS = frozenset(
    {
        "goToDefinition",
        "findReferences",
        "hover",
        "documentSymbol",
        "workspaceSymbol",
        "goToImplementation",
        "prepareCallHierarchy",
        "incomingCalls",
        "outgoingCalls",
        "diagnostics",
    }
)


class LSPRuntimeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ServerSpec:
    language_id: str
    suffixes: tuple[str, ...]
    candidates: tuple[tuple[str, ...], ...]


DEFAULT_SERVER_SPECS = (
    ServerSpec(
        "python",
        (".py",),
        (
            ("pyright-langserver", "--stdio"),
            ("pylsp",),
        ),
    ),
    ServerSpec(
        "typescriptreact",
        (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"),
        (("typescript-language-server", "--stdio"),),
    ),
    ServerSpec("go", (".go",), (("gopls",),)),
    ServerSpec("rust", (".rs",), (("rust-analyzer",),)),
)


@dataclass
class _Pending:
    ready: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: str = ""


class LSPClient:
    """One stdio JSON-RPC client for one workspace and language server."""

    def __init__(
        self,
        root: Path,
        command: tuple[str, ...],
        language_id: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ):
        self.root = Path(root).resolve()
        self.command = tuple(command)
        self.language_id = language_id
        self.timeout = timeout
        self._process: subprocess.Popen[bytes] | None = None
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._write_lock = threading.Lock()
        self._state_lock = threading.RLock()
        self._next_id = 0
        self._pending: dict[int, _Pending] = {}
        self._open_documents: dict[Path, int] = {}
        self._diagnostics: dict[str, list[dict[str, Any]]] = {}
        self._closed = False

    def start(self) -> None:
        with self._state_lock:
            if self._process is not None:
                return
            executable = shutil.which(self.command[0])
            if executable is None:
                raise LSPRuntimeError(
                    "LSP_SERVER_UNAVAILABLE",
                    f"language server is not installed: {self.command[0]}",
                )
            command = (executable, *self.command[1:])
            startup: dict[str, Any] = {}
            if os.name == "nt":
                startup["creationflags"] = subprocess.CREATE_NO_WINDOW
            try:
                self._process = subprocess.Popen(
                    command,
                    cwd=self.root,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=_server_environment(),
                    shell=False,
                    **startup,
                )
            except OSError as exc:
                raise LSPRuntimeError("LSP_START_FAILED", str(exc)) from None
            self._reader = threading.Thread(
                target=self._read_loop,
                name=f"arforge-lsp-{self.language_id}",
                daemon=True,
            )
            self._stderr_reader = threading.Thread(
                target=self._drain_stderr,
                name=f"arforge-lsp-{self.language_id}-stderr",
                daemon=True,
            )
            self._reader.start()
            self._stderr_reader.start()
        initialize = self.request(
            "initialize",
            {
                "processId": os.getpid(),
                "rootUri": self.root.as_uri(),
                "workspaceFolders": [{"uri": self.root.as_uri(), "name": self.root.name}],
                "capabilities": {
                    "workspace": {"workspaceFolders": True, "configuration": True},
                    "textDocument": {
                        "definition": {"linkSupport": True},
                        "implementation": {"linkSupport": True},
                        "hover": {"contentFormat": ["markdown", "plaintext"]},
                        "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                        "callHierarchy": {"dynamicRegistration": False},
                        "publishDiagnostics": {"relatedInformation": True},
                    },
                },
                "clientInfo": {"name": "Arforge Agent"},
            },
        )
        if not isinstance(initialize, dict):
            self.close(force=True)
            raise LSPRuntimeError("LSP_INITIALIZE_FAILED", "language server returned an invalid initialize response")
        self.notify("initialized", {})

    def request(self, method: str, params: dict[str, Any]) -> Any:
        self.start_if_needed()
        with self._state_lock:
            self._next_id += 1
            request_id = self._next_id
            pending = _Pending()
            self._pending[request_id] = pending
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        if not pending.ready.wait(self.timeout):
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise LSPRuntimeError("LSP_TIMEOUT", f"language server request timed out: {method}")
        if pending.error:
            raise LSPRuntimeError("LSP_REQUEST_FAILED", pending.error)
        return pending.result

    def start_if_needed(self) -> None:
        if self._process is None:
            self.start()
        process = self._process
        if process is None or process.poll() is not None:
            raise LSPRuntimeError("LSP_SERVER_STOPPED", "language server is not running")

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.start_if_needed()
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def open_document(self, path: Path) -> None:
        target = Path(path).resolve()
        stat = target.stat()
        if stat.st_size > MAX_FILE_BYTES:
            raise LSPRuntimeError("LSP_FILE_TOO_LARGE", "source file exceeds 10 MB")
        version = int(stat.st_mtime_ns)
        with self._state_lock:
            if self._open_documents.get(target) == version:
                return
        text = target.read_text(encoding="utf-8", errors="replace")
        uri = target.as_uri()
        if target in self._open_documents:
            self.notify(
                "textDocument/didChange",
                {
                    "textDocument": {"uri": uri, "version": version},
                    "contentChanges": [{"text": text}],
                },
            )
        else:
            self.notify(
                "textDocument/didOpen",
                {
                    "textDocument": {
                        "uri": uri,
                        "languageId": _language_id_for_path(target, self.language_id),
                        "version": version,
                        "text": text,
                    }
                },
            )
        with self._state_lock:
            self._open_documents[target] = version

    def diagnostics(self, path: Path, wait_seconds: float = 0.35) -> list[dict[str, Any]]:
        self.open_document(path)
        uri = path.resolve().as_uri()
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            with self._state_lock:
                if uri in self._diagnostics:
                    return self._diagnostics[uri]
            time.sleep(0.02)
        with self._state_lock:
            return self._diagnostics.get(uri, [])

    def close(self, *, force: bool = False) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            process = self._process
        if process is None:
            return
        if not force and process.poll() is None:
            try:
                self.request("shutdown", {})
                self.notify("exit", {})
                process.wait(timeout=1.5)
            except Exception:
                force = True
        if force and process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        self._fail_pending("language server closed")

    def _send(self, payload: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None or process.poll() is not None:
            raise LSPRuntimeError("LSP_SERVER_STOPPED", "language server is not running")
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_MESSAGE_BYTES:
            raise LSPRuntimeError("LSP_MESSAGE_TOO_LARGE", "language server message exceeds 10 MB")
        frame = f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii") + encoded
        try:
            with self._write_lock:
                process.stdin.write(frame)
                process.stdin.flush()
        except OSError:
            self._fail_pending("language server pipe closed")
            raise LSPRuntimeError("LSP_SERVER_STOPPED", "language server pipe closed") from None

    def _read_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            while True:
                headers: dict[str, str] = {}
                while True:
                    line = process.stdout.readline()
                    if not line:
                        raise EOFError
                    if line in {b"\r\n", b"\n"}:
                        break
                    decoded = line.decode("ascii", errors="replace")
                    key, _, value = decoded.partition(":")
                    headers[key.strip().casefold()] = value.strip()
                try:
                    length = int(headers.get("content-length", ""))
                except ValueError:
                    raise LSPRuntimeError("LSP_PROTOCOL_ERROR", "invalid Content-Length") from None
                if not 0 <= length <= MAX_MESSAGE_BYTES:
                    raise LSPRuntimeError("LSP_PROTOCOL_ERROR", "language server message size is invalid")
                body = process.stdout.read(length)
                if len(body) != length:
                    raise EOFError
                message = json.loads(body.decode("utf-8"))
                self._handle_message(message)
        except (EOFError, OSError, json.JSONDecodeError, LSPRuntimeError) as exc:
            self._fail_pending(str(exc) or "language server stopped")

    def _handle_message(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        if "id" in message and ("result" in message or "error" in message):
            request_id = message.get("id")
            if not isinstance(request_id, int):
                return
            with self._state_lock:
                pending = self._pending.pop(request_id, None)
            if pending is None:
                return
            if "error" in message:
                error = message.get("error")
                pending.error = str(error.get("message", error)) if isinstance(error, dict) else str(error)
            else:
                pending.result = message.get("result")
            pending.ready.set()
            return
        method = message.get("method")
        params = message.get("params")
        if method == "textDocument/publishDiagnostics" and isinstance(params, dict):
            uri = params.get("uri")
            diagnostics = params.get("diagnostics")
            if isinstance(uri, str) and isinstance(diagnostics, list):
                with self._state_lock:
                    self._diagnostics[uri] = [item for item in diagnostics if isinstance(item, dict)]
            return
        if "id" in message and isinstance(method, str):
            result: Any = None
            if method == "workspace/configuration":
                items = params.get("items", []) if isinstance(params, dict) else []
                result = [{} for _ in items] if isinstance(items, list) else []
            elif method == "workspace/workspaceFolders":
                result = [{"uri": self.root.as_uri(), "name": self.root.name}]
            self._send({"jsonrpc": "2.0", "id": message["id"], "result": result})

    def _drain_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        try:
            while process.stderr.read(4096):
                pass
        except OSError:
            pass

    def _fail_pending(self, message: str) -> None:
        with self._state_lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for item in pending:
            item.error = message
            item.ready.set()


class LSPManager:
    def __init__(
        self,
        root: Path,
        specs: tuple[ServerSpec, ...] = DEFAULT_SERVER_SPECS,
    ):
        self.root = Path(root).resolve()
        self.specs = specs
        self._clients: dict[str, LSPClient] = {}
        self._lock = threading.RLock()

    def server_status(self) -> dict[str, Any]:
        items = []
        for spec in self.specs:
            command = _first_available(spec.candidates)
            items.append(
                {
                    "language": spec.language_id,
                    "suffixes": list(spec.suffixes),
                    "available": command is not None,
                    "command": command[0] if command else None,
                    "running": spec.language_id in self._clients,
                }
            )
        return {"workspace": str(self.root), "items": items}

    def query(
        self,
        operation: str,
        path: Path,
        line: int,
        character: int,
    ) -> dict[str, Any]:
        if operation not in OPERATIONS:
            raise LSPRuntimeError("INVALID_OPERATION", f"unsupported LSP operation: {operation}")
        target = Path(path).resolve()
        if not target.is_file():
            raise LSPRuntimeError("INVALID_PATH", "LSP target must be an existing file")
        if self.root != target and self.root not in target.parents:
            raise LSPRuntimeError("PATH_OUTSIDE_WORKSPACE", "LSP target is outside the workspace")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise LSPRuntimeError("LSP_FILE_TOO_LARGE", "source file exceeds 10 MB")
        if isinstance(line, bool) or not isinstance(line, int) or line < 1:
            raise LSPRuntimeError("INVALID_POSITION", "line must be a positive integer")
        if isinstance(character, bool) or not isinstance(character, int) or character < 1:
            raise LSPRuntimeError("INVALID_POSITION", "character must be a positive integer")
        lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
        if line > max(len(lines), 1):
            raise LSPRuntimeError("INVALID_POSITION", "line is outside the file")
        if lines and character > len(lines[line - 1]) + 1:
            raise LSPRuntimeError("INVALID_POSITION", "character is outside the line")

        spec = next((item for item in self.specs if target.suffix.lower() in item.suffixes), None)
        if spec is None:
            return _fallback_query(operation, target, line, character, self.root)
        command = _first_available(spec.candidates)
        if command is None:
            return _fallback_query(operation, target, line, character, self.root)
        try:
            client = self._client(spec, command)
            client.open_document(target)
            result = self._request_operation(client, operation, target, line, character)
            normalized = _normalize_result(result, self.root)
            return {
                "schema_version": 1,
                "backend": "language-server",
                "language": spec.language_id,
                "server": command[0],
                "operation": operation,
                "file": target.relative_to(self.root).as_posix(),
                "result": normalized,
                **_result_counts(normalized),
            }
        except LSPRuntimeError as exc:
            fallback = _fallback_query(operation, target, line, character, self.root)
            fallback["server_error"] = {"code": exc.code, "message": exc.message}
            return fallback

    def close(self) -> None:
        with self._lock:
            clients = list(self._clients.values())
            self._clients.clear()
        for client in clients:
            client.close()

    def _client(self, spec: ServerSpec, command: tuple[str, ...]) -> LSPClient:
        with self._lock:
            client = self._clients.get(spec.language_id)
            if client is None:
                client = LSPClient(self.root, command, spec.language_id)
                client.start()
                self._clients[spec.language_id] = client
            return client

    @staticmethod
    def _request_operation(
        client: LSPClient,
        operation: str,
        target: Path,
        line: int,
        character: int,
    ) -> Any:
        text_document = {"uri": target.as_uri()}
        position = {"line": line - 1, "character": character - 1}
        position_params = {"textDocument": text_document, "position": position}
        if operation == "goToDefinition":
            return client.request("textDocument/definition", position_params)
        if operation == "findReferences":
            return client.request(
                "textDocument/references",
                {**position_params, "context": {"includeDeclaration": True}},
            )
        if operation == "hover":
            return client.request("textDocument/hover", position_params)
        if operation == "documentSymbol":
            return client.request("textDocument/documentSymbol", {"textDocument": text_document})
        if operation == "workspaceSymbol":
            return client.request(
                "workspace/symbol",
                {"query": _symbol_at_position(target, line, character) or ""},
            )
        if operation == "goToImplementation":
            return client.request("textDocument/implementation", position_params)
        if operation == "diagnostics":
            return client.diagnostics(target)
        prepared = client.request("textDocument/prepareCallHierarchy", position_params)
        if operation == "prepareCallHierarchy":
            return prepared
        if not isinstance(prepared, list) or not prepared:
            return []
        method = (
            "callHierarchy/incomingCalls"
            if operation == "incomingCalls"
            else "callHierarchy/outgoingCalls"
        )
        return client.request(method, {"item": prepared[0]})


def _server_environment() -> dict[str, str]:
    allowed = {
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "GOPATH",
        "GOROOT",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "NODE_PATH",
        "PYTHONPATH",
        "VIRTUAL_ENV",
    }
    return {key: value for key, value in os.environ.items() if key.upper() in allowed}


def _first_available(candidates: tuple[tuple[str, ...], ...]) -> tuple[str, ...] | None:
    return next((command for command in candidates if shutil.which(command[0])), None)


def _symbol_at_position(path: Path, line: int, character: int) -> str:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if not lines or line > len(lines):
        return ""
    content = lines[line - 1]
    offset = min(max(character - 1, 0), max(len(content) - 1, 0))
    for match in re.finditer(r"[A-Za-z_$][A-Za-z0-9_$]*", content):
        if match.start() <= offset < match.end():
            return match.group(0)
    return ""


def _normalize_result(value: Any, root: Path) -> Any:
    if isinstance(value, list):
        return [_normalize_result(item, root) for item in value]
    if not isinstance(value, dict):
        return value
    normalized: dict[str, Any] = {}
    for key, item in value.items():
        if key in {"uri", "targetUri"} and isinstance(item, str):
            normalized["file" if key == "uri" else "targetFile"] = _display_uri(item, root)
        elif key in {"range", "selectionRange", "targetRange", "targetSelectionRange"} and isinstance(item, dict):
            normalized[key] = _normalize_range(item)
        else:
            normalized[key] = _normalize_result(item, root)
    return normalized


def _normalize_range(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in ("start", "end"):
        point = value.get(name)
        if isinstance(point, dict):
            result[name] = {
                "line": int(point.get("line", 0)) + 1,
                "character": int(point.get("character", 0)) + 1,
            }
    return result


def _display_uri(uri: str, root: Path) -> str:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        return uri
    raw = unquote(parsed.path)
    if os.name == "nt" and re.match(r"^/[A-Za-z]:", raw):
        raw = raw[1:]
    path = Path(raw).resolve()
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _result_counts(value: Any) -> dict[str, int]:
    items = value if isinstance(value, list) else ([] if value is None else [value])
    files: set[str] = set()

    def collect(item: Any) -> None:
        if isinstance(item, dict):
            for key, nested in item.items():
                if key in {"file", "targetFile"} and isinstance(nested, str):
                    files.add(nested)
                else:
                    collect(nested)
        elif isinstance(item, list):
            for nested in item:
                collect(nested)

    collect(items)
    return {"result_count": len(items), "file_count": len(files)}


def _fallback_query(
    operation: str,
    target: Path,
    line: int,
    character: int,
    root: Path,
) -> dict[str, Any]:
    symbol = _symbol_at_position(target, line, character)
    relative = target.relative_to(root).as_posix()
    if operation == "hover":
        lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
        result: Any = {
            "symbol": symbol,
            "line": line,
            "content": lines[line - 1].strip() if lines else "",
        }
    elif operation == "documentSymbol":
        result = _document_symbols(target)
    elif operation == "workspaceSymbol":
        result = _workspace_symbols(root, symbol)
    elif operation in {"goToDefinition", "goToImplementation", "prepareCallHierarchy"}:
        result = _find_definitions(root, symbol)
    elif operation in {"findReferences", "incomingCalls"}:
        result = _find_references(root, symbol)
    elif operation == "outgoingCalls":
        result = []
    elif operation == "diagnostics":
        result = _fallback_diagnostics(target)
    else:
        result = []
    return {
        "schema_version": 1,
        "backend": "index-fallback",
        "language": target.suffix.lower().lstrip("."),
        "server": None,
        "operation": operation,
        "file": relative,
        "symbol": symbol,
        "result": result,
        **_result_counts(result),
    }


def _document_symbols(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".py":
        try:
            from arforge.core.code_indexer import extract_python_symbols

            symbols = extract_python_symbols(str(path))
            if symbols:
                return symbols
        except Exception:
            pass
    else:
        from arforge.core.symbol_index import extract_symbols_from_file

        symbols = extract_symbols_from_file(path)
        if symbols:
            return symbols
    return _lexical_symbols(path)


def _lexical_symbols(path: Path) -> list[dict[str, Any]]:
    patterns = {
        ".py": re.compile(r"^\s*(?:(async)\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ".js": re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
        ".jsx": re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
        ".ts": re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
        ".tsx": re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
        ".go": re.compile(r"^\s*(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)"),
        ".rs": re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)"),
    }
    pattern = patterns.get(path.suffix.lower())
    if pattern is None:
        return []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    symbols: list[dict[str, Any]] = []
    for line_number, content in enumerate(lines, 1):
        match = pattern.match(content)
        if match is None:
            continue
        groups = [item for item in match.groups() if item]
        if path.suffix.lower() == ".py":
            kind = groups[-2]
            name = groups[-1]
        else:
            kind, name = groups[-2:]
        symbols.append({"name": name, "type": kind, "line": line_number})
    return symbols


def _workspace_symbols(root: Path, query: str, limit: int = 100) -> list[dict[str, Any]]:
    from arforge.project_scanner import scan_project

    results: list[dict[str, Any]] = []
    suffixes = (".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs")
    for item in scan_project(root, suffixes=suffixes):
        path = root / item["path"]
        for symbol in _document_symbols(path):
            name = str(symbol.get("name", ""))
            if not query or query.casefold() in name.casefold():
                results.append({**symbol, "file": item["path"]})
                if len(results) >= limit:
                    return results
    return results


def _find_definitions(root: Path, symbol: str) -> list[dict[str, Any]]:
    if not symbol:
        return []
    return [
        item for item in _workspace_symbols(root, symbol)
        if str(item.get("name", "")).casefold() == symbol.casefold()
    ]


def _find_references(root: Path, symbol: str, limit: int = 200) -> list[dict[str, Any]]:
    if not symbol:
        return []
    from arforge.project_scanner import scan_project

    pattern = re.compile(rf"\b{re.escape(symbol)}\b")
    results: list[dict[str, Any]] = []
    suffixes = (".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs")
    for item in scan_project(root, suffixes=suffixes):
        path = root / item["path"]
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line_number, content in enumerate(lines, 1):
            for match in pattern.finditer(content):
                results.append(
                    {
                        "file": item["path"],
                        "range": {
                            "start": {"line": line_number, "character": match.start() + 1},
                            "end": {"line": line_number, "character": match.end() + 1},
                        },
                    }
                )
                if len(results) >= limit:
                    return results
    return results


def _fallback_diagnostics(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() != ".py":
        return []
    source = path.read_text(encoding="utf-8", errors="replace")
    try:
        compile(source, str(path), "exec")
    except SyntaxError as exc:
        return [
            {
                "severity": 1,
                "message": exc.msg,
                "range": {
                    "start": {"line": exc.lineno or 1, "character": exc.offset or 1},
                    "end": {"line": exc.lineno or 1, "character": (exc.offset or 1) + 1},
                },
                "source": "python-compile",
            }
        ]
    return []


def _language_id_for_path(path: Path, default: str) -> str:
    return {
        ".js": "javascript",
        ".mjs": "javascript",
        ".cjs": "javascript",
        ".jsx": "javascriptreact",
        ".ts": "typescript",
        ".tsx": "typescriptreact",
    }.get(path.suffix.lower(), default)


_MANAGER: LSPManager | None = None
_MANAGER_ROOT: Path | None = None
_MANAGER_LOCK = threading.Lock()


def get_lsp_manager(root: Path | None = None) -> LSPManager:
    global _MANAGER, _MANAGER_ROOT
    selected = Path(root or Path.cwd()).resolve()
    if _MANAGER is None or _MANAGER_ROOT != selected:
        with _MANAGER_LOCK:
            if _MANAGER is None or _MANAGER_ROOT != selected:
                if _MANAGER is not None:
                    _MANAGER.close()
                _MANAGER = LSPManager(selected)
                _MANAGER_ROOT = selected
    return _MANAGER


def shutdown_lsp_manager() -> None:
    global _MANAGER, _MANAGER_ROOT
    with _MANAGER_LOCK:
        manager = _MANAGER
        _MANAGER = None
        _MANAGER_ROOT = None
    if manager is not None:
        manager.close()


atexit.register(shutdown_lsp_manager)
