"""Agent Client Protocol adapter backed by Arforge's canonical runtime.

The adapter is intentionally a transport layer: it reuses SessionRuntime,
tool registration, permissions, model configuration, and persistence instead
of introducing an IDE-specific agent implementation.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, TextIO

from arforge.paths import data_path
from arforge.product.session_runtime import (
    DEFAULT_TIMEOUT_MS,
    TERMINAL_OPERATION_STATUSES,
    SessionRuntime,
    SessionRuntimeError,
)
from arforge.product.state_store import BridgeStateStore
from arforge.security_guard import sanitize_log_message

JSON_RPC_VERSION = "2.0"
ACP_PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_IMAGE_BYTES = 100 * 1024 * 1024
PERMISSION_TIMEOUT_SECONDS = 600.0


class AcpError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class JsonRpcPeer:
    """Thread-safe newline JSON-RPC peer with reverse-request support."""

    def __init__(self, output_stream: TextIO):
        self._output = output_stream
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        self._next_id = 0

    def write(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._write_lock:
            self._output.write(line)
            self._output.flush()

    def result(self, request_id: Any, result: Any) -> None:
        self.write({"jsonrpc": JSON_RPC_VERSION, "id": request_id, "result": result})

    def error(self, request_id: Any, error: AcpError) -> None:
        payload: dict[str, Any] = {"code": error.code, "message": error.message}
        if error.data is not None:
            payload["data"] = error.data
        self.write({"jsonrpc": JSON_RPC_VERSION, "id": request_id, "error": payload})

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.write(
            {
                "jsonrpc": JSON_RPC_VERSION,
                "method": method,
                "params": params,
            }
        )

    def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = PERMISSION_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        with self._pending_lock:
            self._next_id += 1
            request_id = f"arforge-{self._next_id}"
            ready = threading.Event()
            box: dict[str, Any] = {}
            self._pending[request_id] = (ready, box)
        self.write(
            {
                "jsonrpc": JSON_RPC_VERSION,
                "id": request_id,
                "method": method,
                "params": params,
            }
        )
        if not ready.wait(timeout):
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise AcpError(-32001, "client request timed out")
        if "error" in box:
            error = box["error"]
            raise AcpError(
                int(error.get("code", -32000)),
                str(error.get("message", "client request failed")),
                error.get("data"),
            )
        result = box.get("result", {})
        return result if isinstance(result, dict) else {}

    def accept_response(self, message: dict[str, Any]) -> bool:
        request_id = message.get("id")
        key = str(request_id)
        with self._pending_lock:
            pending = self._pending.pop(key, None)
        if pending is None:
            return False
        ready, box = pending
        if "error" in message:
            box["error"] = message["error"]
        else:
            box["result"] = message.get("result")
        ready.set()
        return True


class AcpServer:
    """Production ACP method surface over one workspace-bound runtime."""

    def __init__(
        self,
        output_stream: TextIO,
        *,
        workspace: Path | None = None,
        state_path: Path | None = None,
        agent_factory: Callable[[], Any] | None = None,
    ):
        self.workspace = (workspace or Path.cwd()).resolve()
        self.peer = JsonRpcPeer(output_stream)
        self.store = BridgeStateStore(
            state_path or data_path("state", "ide_sessions.db")
        )
        self.project = self.store.ensure_project(self.workspace)
        self._initialized = False
        self._client_capabilities: dict[str, Any] = {}
        self._operation_done: dict[str, threading.Event] = {}
        self._operation_sessions: dict[str, str] = {}
        self._session_modes: dict[str, str] = {}
        self._session_thinking: dict[str, str] = {}
        self._session_approvals: dict[str, set[str]] = {}
        self._mcp_names: set[str] = set()
        self._active = True
        self._threads: set[threading.Thread] = set()
        self._threads_lock = threading.Lock()

        from arforge.product.direct_dispatch import install_agentic_hooks, register_builtin_tools

        register_builtin_tools()
        install_agentic_hooks()
        self.runtime = SessionRuntime(
            self._on_runtime_event,
            agent_factory=agent_factory,
            store=self.store,
            project=self.project,
        )

    def close(self) -> None:
        self._active = False
        self.runtime.shutdown()
        if self._mcp_names:
            from arforge.mcp_client_runtime import get_mcp_client_manager

            manager = get_mcp_client_manager()
            for name in list(self._mcp_names):
                try:
                    manager.disconnect(name)
                except Exception:
                    pass
            self._mcp_names.clear()
        with self._threads_lock:
            threads = list(self._threads)
        for thread in threads:
            if thread is not threading.current_thread() and thread.is_alive():
                thread.join(timeout=2.0)

    def serve(self, input_stream: TextIO) -> int:
        try:
            for line_number, raw_line in enumerate(input_stream):
                if line_number == 0:
                    raw_line = raw_line.lstrip("\ufeff")
                if not raw_line.strip():
                    continue
                try:
                    if len(raw_line.encode("utf-8")) > MAX_MESSAGE_BYTES:
                        raise AcpError(-32600, "request exceeds 1 MiB")
                    message = json.loads(raw_line)
                    if not isinstance(message, dict):
                        raise AcpError(-32600, "request must be an object")
                except json.JSONDecodeError as exc:
                    self.peer.error(None, AcpError(-32700, f"parse error at column {exc.colno}"))
                    continue
                except AcpError as exc:
                    self.peer.error(None, exc)
                    continue
                if "method" not in message and "id" in message:
                    self.peer.accept_response(message)
                    continue
                self._spawn_request(message)
        finally:
            self.close()
        return 0

    def _spawn_request(self, message: dict[str, Any]) -> None:
        def run() -> None:
            try:
                self._handle(message)
            finally:
                with self._threads_lock:
                    self._threads.discard(threading.current_thread())

        thread = threading.Thread(target=run, name="arforge-acp-request", daemon=True)
        with self._threads_lock:
            self._threads.add(thread)
        thread.start()

    def _handle(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        is_notification = "id" not in message
        try:
            if message.get("jsonrpc") != JSON_RPC_VERSION:
                raise AcpError(-32600, "jsonrpc must be 2.0")
            method = message.get("method")
            params = message.get("params", {})
            if not isinstance(method, str) or not method:
                raise AcpError(-32600, "method must be a non-empty string")
            if not isinstance(params, dict):
                raise AcpError(-32602, "params must be an object")
            result = self.dispatch(method, params)
            if not is_notification:
                self.peer.result(request_id, result)
        except AcpError as exc:
            if not is_notification:
                self.peer.error(request_id, exc)
        except SessionRuntimeError as exc:
            if not is_notification:
                self.peer.error(request_id, AcpError(-32602, exc.message, {"code": exc.code}))
        except Exception as exc:
            if not is_notification:
                self.peer.error(
                    request_id,
                    AcpError(-32000, sanitize_log_message(str(exc)) or "agent operation failed"),
                )

    def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "initialize":
            return self._initialize(params)
        if not self._initialized:
            raise AcpError(-32002, "initialize must be called first")
        if method == "authenticate":
            return self._authenticate(params)
        if method == "session/new":
            return self._new_session(params)
        if method in {"session/load", "session/resume"}:
            return self._load_session(params, replay=method == "session/load")
        if method == "session/list":
            return self._list_sessions(params)
        if method == "session/prompt":
            return self._prompt(params)
        if method == "session/cancel":
            return self._cancel(params)
        if method == "session/close":
            return self.runtime.close_session(self._session_id(params))
        if method == "session/set_mode":
            return self._set_mode(params)
        if method in {"session/set_config_option", "session/set_model"}:
            return self._set_config_option(method, params)
        if method == "logout":
            raise AcpError(-32601, "logout is not available through the IDE protocol")
        raise AcpError(-32601, f"method not found: {method}")

    def _initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        version = params.get("protocolVersion")
        if not isinstance(version, int) or isinstance(version, bool):
            raise AcpError(-32602, "protocolVersion must be an integer")
        capabilities = params.get("clientCapabilities", {})
        if not isinstance(capabilities, dict):
            raise AcpError(-32602, "clientCapabilities must be an object")
        self._client_capabilities = capabilities
        self._initialized = True
        try:
            from arforge import __version__
        except ImportError:
            __version__ = "unknown"
        return {
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "agentCapabilities": {
                "loadSession": True,
                "promptCapabilities": {
                    "image": True,
                    "audio": False,
                    "embeddedContext": True,
                },
                "mcpCapabilities": {"http": True, "sse": True},
                "sessionCapabilities": {"list": {}},
            },
            "authMethods": [
                {
                    "id": "configured-provider",
                    "name": "Configured model provider",
                    "description": "Uses credentials already stored by Arforge.",
                }
            ],
            "agentInfo": {"name": "Arforge Agent", "version": __version__},
        }

    @staticmethod
    def _provider_config() -> dict[str, Any]:
        from arforge.product.model_config_runtime import get_model_config

        return get_model_config().get_resolved_config()

    def _require_auth(self) -> dict[str, Any]:
        resolved = self._provider_config()
        if not resolved.get("resolved"):
            raise AcpError(-32000, "authentication required")
        return resolved

    def _authenticate(self, params: dict[str, Any]) -> dict[str, Any]:
        method_id = params.get("methodId", params.get("method_id"))
        if method_id not in {"configured-provider", "login"}:
            raise AcpError(-32602, "unknown authentication method")
        self._require_auth()
        return {}

    def _validate_cwd(self, value: Any) -> None:
        if value in {None, ""}:
            return
        if not isinstance(value, str):
            raise AcpError(-32602, "cwd must be a string")
        if Path(value).resolve() != self.workspace:
            raise AcpError(
                -32602,
                "this agent process is bound to its launch workspace",
            )

    def _new_session(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_auth()
        self._validate_cwd(params.get("cwd"))
        self._connect_mcp_servers(params.get("mcpServers", []))
        session = self.runtime.create_session()
        session_id = session["session_id"]
        self._session_modes[session_id] = "default"
        self._session_thinking[session_id] = "medium"
        return {
            "sessionId": session_id,
            "configOptions": self._config_options(session_id),
        }

    def _load_session(self, params: dict[str, Any], *, replay: bool) -> dict[str, Any]:
        self._require_auth()
        self._validate_cwd(params.get("cwd"))
        self._connect_mcp_servers(params.get("mcpServers", []))
        session_id = self._session_id(params)
        current = self.runtime.get_session(session_id)
        if current["status"] != "active" or not current["context_available"]:
            self.runtime.resume_session(session_id)
        self._session_modes.setdefault(session_id, "default")
        self._session_thinking.setdefault(session_id, "medium")
        if replay:
            history = self.runtime.get_messages(session_id, 500)
            for message in history.get("items", []):
                update_type = (
                    "user_message_chunk"
                    if message.get("role") == "user"
                    else "agent_message_chunk"
                )
                self._update(
                    session_id,
                    {
                        "sessionUpdate": update_type,
                        "content": {
                            "type": "text",
                            "text": str(message.get("content", "")),
                        },
                    },
                )
        return {"configOptions": self._config_options(session_id)}

    def _list_sessions(self, params: dict[str, Any]) -> dict[str, Any]:
        self._validate_cwd(params.get("cwd"))
        page = self.runtime.filter_sessions(limit=200)
        return {
            "sessions": [
                {
                    "sessionId": item["session_id"],
                    "cwd": str(self.workspace),
                    "title": item["title"],
                    "updatedAt": item["updated_at"],
                }
                for item in page["items"]
            ],
            "nextCursor": None,
        }

    def _prompt(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = self._session_id(params)
        self.runtime.get_session(session_id)
        prompt, context = self._prompt_content(params.get("prompt"))
        mode = self._session_modes.get(session_id, "default")
        permission_mode = {
            "default": "requestApproval",
            "plan": "plan",
            "auto": "auto",
            "yolo": "fullAccess",
        }[mode]
        operation = self.runtime.start_chat(
            session_id,
            prompt,
            DEFAULT_TIMEOUT_MS,
            reasoning_effort=self._session_thinking.get(session_id, "medium"),
            permission_mode=permission_mode,
            context=context,
            confirmation_handler=lambda risk, description: self._request_permission(
                session_id,
                risk,
                description,
            ),
        )
        operation_id = operation["operation_id"]
        ready = threading.Event()
        self._operation_done[operation_id] = ready
        self._operation_sessions[operation_id] = session_id
        self.runtime.release_operation(operation_id)
        while self._active and not ready.wait(0.1):
            latest = self.runtime.get_operation(operation_id)
            if latest["status"] in TERMINAL_OPERATION_STATUSES:
                break
        latest = self.runtime.get_operation(operation_id)
        self._operation_done.pop(operation_id, None)
        self._operation_sessions.pop(operation_id, None)
        status = latest.get("status")
        if status in {"failed", "timed_out"}:
            raise AcpError(-32000, str(latest.get("error") or f"operation {status}"))
        return {
            "stopReason": (
                "cancelled"
                if status == "cancelled"
                else "max_tokens"
                if status == "incomplete"
                else "end_turn"
            )
        }

    def _cancel(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = self._session_id(params)
        operation_id = self.runtime.active_operation_id(session_id)
        if operation_id:
            self.runtime.cancel_operation(operation_id)
        return {}

    def _set_mode(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = self._session_id(params)
        mode = params.get("modeId")
        if mode not in {"default", "plan", "auto", "yolo"}:
            raise AcpError(-32602, "unknown mode")
        self.runtime.get_session(session_id)
        self._session_modes[session_id] = mode
        self._update(
            session_id,
            {
                "sessionUpdate": "config_option_update",
                "configOptions": self._config_options(session_id),
            },
        )
        return {}

    def _set_config_option(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        session_id = self._session_id(params)
        config_id = "model" if method == "session/set_model" else params.get("configId")
        value = params.get("modelId") if method == "session/set_model" else params.get("value")
        if config_id == "mode":
            return self._set_mode({"sessionId": session_id, "modeId": value})
        if config_id == "thinking":
            if value not in {"low", "medium", "high", "ultra"}:
                raise AcpError(-32602, "thinking must be low, medium, high, or ultra")
            self._session_thinking[session_id] = str(value)
        elif config_id == "model":
            if not isinstance(value, str) or ":" not in value:
                raise AcpError(-32602, "model value must be provider:model")
            provider, model = value.split(":", 1)
            from arforge.product.model_config_runtime import get_model_config

            config = get_model_config()
            known = {
                f"{item['id']}:{candidate}"
                for item in config.list_providers()
                for candidate in item.get("models", [])
            }
            if value not in known:
                raise AcpError(-32602, "unknown model")
            config.set_model(provider, model)
            config.set_active_provider(provider)
            self.runtime.refresh_session_agent(session_id)
        else:
            raise AcpError(-32602, "unknown config option")
        options = self._config_options(session_id)
        self._update(
            session_id,
            {
                "sessionUpdate": "config_option_update",
                "configOptions": options,
            },
        )
        return {"configOptions": options}

    def _config_options(self, session_id: str) -> list[dict[str, Any]]:
        from arforge.product.model_config_runtime import get_model_config

        config = get_model_config()
        active = config.get_resolved_config()
        model_options = []
        for provider in config.list_providers():
            for model in provider.get("models", []):
                model_options.append(
                    {
                        "value": f"{provider['id']}:{model}",
                        "name": f"{provider['label']} · {model}",
                    }
                )
        active_value = (
            f"{active.get('provider')}:{active.get('model')}"
            if active.get("provider") and active.get("model")
            else ""
        )
        return [
            {
                "type": "select",
                "id": "model",
                "name": "Model",
                "category": "model",
                "currentValue": active_value,
                "options": model_options,
            },
            {
                "type": "select",
                "id": "thinking",
                "name": "Thinking",
                "category": "thought_level",
                "currentValue": self._session_thinking.get(session_id, "medium"),
                "options": [
                    {"value": value, "name": value.title()}
                    for value in ("low", "medium", "high", "ultra")
                ],
            },
            {
                "type": "select",
                "id": "mode",
                "name": "Mode",
                "category": "mode",
                "currentValue": self._session_modes.get(session_id, "default"),
                "options": [
                    {"value": "default", "name": "Default"},
                    {"value": "plan", "name": "Plan"},
                    {"value": "auto", "name": "Auto"},
                    {"value": "yolo", "name": "Full access"},
                ],
            },
        ]

    def _prompt_content(self, value: Any) -> tuple[str, dict[str, Any]]:
        blocks = value if isinstance(value, list) else []
        if not blocks:
            raise AcpError(-32602, "prompt must contain at least one content block")
        text_parts: list[str] = []
        paths: list[dict[str, str]] = []
        for block in blocks:
            if not isinstance(block, dict):
                raise AcpError(-32602, "prompt blocks must be objects")
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    text_parts.append(text)
            elif block_type == "image":
                path = self._materialize_image(block)
                paths.append({"path": str(path), "kind": "file"})
                text_parts.append(f"[Attached image available at {path}]")
            elif block_type == "resource":
                resource = block.get("resource")
                if isinstance(resource, dict) and isinstance(resource.get("text"), str):
                    uri = str(resource.get("uri", "embedded"))
                    text_parts.append(
                        f'<resource uri="{uri}">\n{resource["text"]}\n</resource>'
                    )
            elif block_type == "resource_link":
                uri = block.get("uri")
                if isinstance(uri, str) and uri:
                    text_parts.append(f"[Linked resource: {uri}]")
            elif block_type == "audio":
                raise AcpError(-32602, "audio prompts are not supported")
        prompt = "\n\n".join(text_parts).strip()
        if not prompt:
            raise AcpError(-32602, "prompt did not contain usable content")
        return prompt, {"paths": paths} if paths else {}

    def _materialize_image(self, block: dict[str, Any]) -> Path:
        encoded = block.get("data")
        mime_type = block.get("mimeType")
        if not isinstance(encoded, str) or not isinstance(mime_type, str):
            raise AcpError(-32602, "image requires base64 data and mimeType")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            raise AcpError(-32602, "image data is not valid base64") from None
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            raise AcpError(-32602, "image exceeds the supported size")
        extension = mimetypes.guess_extension(mime_type.split(";", 1)[0]) or ".bin"
        attachment_dir = self.workspace / ".arforge" / "ide-attachments"
        attachment_dir.mkdir(parents=True, exist_ok=True)
        path = attachment_dir / f"{uuid.uuid4().hex}{extension}"
        path.write_bytes(raw)
        return path

    def _request_permission(self, session_id: str, risk: str, description: str) -> bool:
        approved = self._session_approvals.setdefault(session_id, set())
        if description in approved:
            return True
        response = self.peer.request(
            "session/request_permission",
            {
                "sessionId": session_id,
                "toolCall": {
                    "toolCallId": f"permission-{uuid.uuid4().hex[:12]}",
                    "title": description,
                    "status": "pending",
                    "content": [
                        {
                            "type": "content",
                            "content": {
                                "type": "text",
                                "text": f"Risk: {risk}\n{description}",
                            },
                        }
                    ],
                },
                "options": [
                    {"optionId": "allow_once", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "allow_session", "name": "Allow for session", "kind": "allow_always"},
                    {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
                ],
            },
        )
        outcome = response.get("outcome", {})
        if not isinstance(outcome, dict) or outcome.get("outcome") != "selected":
            return False
        option_id = outcome.get("optionId")
        if option_id == "allow_session":
            approved.add(description)
            return True
        return option_id == "allow_once"

    def _on_runtime_event(self, event: dict[str, Any]) -> None:
        session_id = str(event.get("session_id", ""))
        event_type = event.get("type")
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        operation_id = str(event.get("operation_id", ""))
        if event_type == "answer.delta":
            self._update(
                session_id,
                {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": str(data.get("content", ""))},
                },
            )
        elif event_type == "reasoning.delta":
            self._update(
                session_id,
                {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": {"type": "text", "text": str(data.get("content", ""))},
                },
            )
        elif event_type == "tool.prepared":
            self._update(
                session_id,
                {
                    "sessionUpdate": "tool_call",
                    "toolCallId": f"{operation_id}:{event.get('sequence', 0)}",
                    "title": str(data.get("tool_name", "tool")),
                    "kind": self._tool_kind(str(data.get("tool_name", ""))),
                    "status": "in_progress",
                    "content": [
                        {
                            "type": "content",
                            "content": {
                                "type": "text",
                                "text": str(data.get("summary", "")),
                            },
                        }
                    ],
                },
            )
        elif event_type == "tool.completed":
            self._update(
                session_id,
                {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": f"{operation_id}:{max(0, int(event.get('sequence', 0)) - 1)}",
                    "status": "completed" if data.get("success") else "failed",
                    "content": [
                        {
                            "type": "content",
                            "content": {
                                "type": "text",
                                "text": str(data.get("summary") or data.get("error") or ""),
                            },
                        }
                    ],
                },
            )
        elif event_type == "question.requested":
            threading.Thread(
                target=self._bridge_question,
                args=(session_id, data),
                name="arforge-acp-question",
                daemon=True,
            ).start()
        if event_type in {
            "operation.completed",
            "operation.failed",
            "operation.cancelled",
            "operation.timed_out",
        }:
            ready = self._operation_done.get(operation_id)
            if ready is not None:
                ready.set()

    def _bridge_question(self, session_id: str, data: dict[str, Any]) -> None:
        questions = data.get("questions")
        if not isinstance(questions, list) or not questions:
            return
        question = questions[0]
        if not isinstance(question, dict):
            return
        options = [
            {
                "optionId": f"answer-{index}",
                "name": str(option.get("label", "")),
                "kind": "allow_once",
            }
            for index, option in enumerate(question.get("options", []))
            if isinstance(option, dict)
        ]
        options.append({"optionId": "skip", "name": "Skip", "kind": "reject_once"})
        try:
            response = self.peer.request(
                "session/request_permission",
                {
                    "sessionId": session_id,
                    "toolCall": {
                        "toolCallId": f"question-{data.get('question_id', '')}",
                        "title": str(question.get("header") or "Question"),
                        "status": "pending",
                        "content": [
                            {
                                "type": "content",
                                "content": {
                                    "type": "text",
                                    "text": str(question.get("question", "")),
                                },
                            }
                        ],
                    },
                    "options": options,
                },
            )
            outcome = response.get("outcome", {})
            option_id = outcome.get("optionId") if isinstance(outcome, dict) else None
            if not isinstance(option_id, str) or not option_id.startswith("answer-"):
                self.runtime.reject_question(session_id, data.get("question_id"))
                return
            index = int(option_id.split("-", 1)[1])
            selected = question["options"][index]["label"]
            answers = {
                item["question"]: (
                    selected
                    if item is question
                    else item["options"][0]["label"]
                )
                for item in questions
            }
            self.runtime.respond_question(
                session_id,
                data.get("question_id"),
                answers,
            )
        except Exception:
            try:
                self.runtime.reject_question(session_id, data.get("question_id"))
            except Exception:
                pass

    def _update(self, session_id: str, update: dict[str, Any]) -> None:
        self.peer.notify("session/update", {"sessionId": session_id, "update": update})

    @staticmethod
    def _session_id(params: dict[str, Any]) -> str:
        value = params.get("sessionId")
        if not isinstance(value, str) or not value:
            raise AcpError(-32602, "sessionId is required")
        return value

    def _connect_mcp_servers(self, value: Any) -> None:
        if value is None or value == []:
            return
        if not isinstance(value, list):
            raise AcpError(-32602, "mcpServers must be an array")
        from arforge.mcp_client_runtime import (
            MCPClientError,
            get_mcp_client_manager,
        )

        manager = get_mcp_client_manager()
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise AcpError(-32602, f"mcpServers[{index}] must be an object")
            raw_name = item.get("name") or f"ide-{index + 1}"
            name = "".join(
                character if character.isalnum() or character in "_-" else "-"
                for character in str(raw_name).casefold()
            ).strip("-")[:64]
            if not name:
                name = f"ide-{index + 1}"
            if name in self._mcp_names:
                continue
            transport = str(item.get("transport") or item.get("type") or "stdio").casefold()
            try:
                if transport == "stdio":
                    command = item.get("command")
                    args = item.get("args", [])
                    env = item.get("env", {})
                    if not isinstance(command, str) or not command.strip():
                        raise AcpError(-32602, f"mcpServers[{index}].command is required")
                    if not isinstance(args, list) or not all(
                        isinstance(arg, str) for arg in args
                    ):
                        raise AcpError(-32602, f"mcpServers[{index}].args must be strings")
                    if not isinstance(env, dict) or not all(
                        isinstance(key, str) and isinstance(val, str)
                        for key, val in env.items()
                    ):
                        raise AcpError(-32602, f"mcpServers[{index}].env must be string pairs")
                    manager.connect_stdio(
                        name,
                        [command, *args],
                        cwd=str(self.workspace),
                        env=env,
                    )
                elif transport in {"http", "sse"}:
                    url = item.get("url")
                    if not isinstance(url, str) or not url:
                        raise AcpError(-32602, f"mcpServers[{index}].url is required")
                    manager.connect_http(name, url, transport=transport)
                elif transport == "acp":
                    raise AcpError(
                        -32602,
                        "nested agent-protocol MCP transport is not supported",
                    )
                else:
                    raise AcpError(
                        -32602,
                        f"unsupported MCP transport: {transport}",
                    )
            except MCPClientError as exc:
                raise AcpError(-32000, f"MCP server {name} failed: {exc.message}") from None
            except ValueError as exc:
                raise AcpError(-32602, str(exc)) from None
            self._mcp_names.add(name)

    @staticmethod
    def _tool_kind(name: str) -> str:
        lowered = name.casefold()
        if any(token in lowered for token in ("read", "grep", "search", "glob", "list")):
            return "read"
        if any(token in lowered for token in ("write", "edit", "patch", "delete")):
            return "edit"
        if any(token in lowered for token in ("cmd", "shell", "test", "run")):
            return "execute"
        if "fetch" in lowered or "web" in lowered or "browser" in lowered:
            return "fetch"
        return "other"


def serve(input_stream: TextIO, output_stream: TextIO) -> int:
    return AcpServer(output_stream).serve(input_stream)


def main() -> int:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    return serve(sys.stdin, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
