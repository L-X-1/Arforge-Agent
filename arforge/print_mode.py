"""Non-interactive text and JSONL execution over the normal session runtime."""

from __future__ import annotations

import json
import re
import sys
import threading
from dataclasses import dataclass
from typing import Any, Iterable, TextIO

from arforge.product.session_runtime import (
    MAX_INPUT_CHARS,
    NO_TIMEOUT_MS,
    SessionRuntime,
    SessionRuntimeError,
)

INPUT_FORMATS = {"text", "stream-json"}
OUTPUT_FORMATS = {"text", "stream-json"}
RETRYABLE_CODES = {"OPERATION_TIMEOUT", "PROVIDER_TIMEOUT", "RATE_LIMITED", "SERVICE_UNAVAILABLE"}
_RETRYABLE_MESSAGE = re.compile(
    r"(?:\b429\b|\b5\d\d\b|rate.?limit|timed?.?out|timeout|temporar|connection|unavailable)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class PrintModeOptions:
    input_format: str = "text"
    output_format: str = "text"
    final_message_only: bool = False
    reasoning_effort: str = "medium"
    permission_mode: str = "autoApprove"


class PrintModeInputError(ValueError):
    pass


def parse_stream_message(line: str, line_number: int) -> str:
    """Validate one JSONL user message and flatten supported text content parts."""

    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        raise PrintModeInputError(
            f"invalid JSONL input at line {line_number}, column {exc.colno}"
        ) from None
    if not isinstance(payload, dict) or payload.get("role") != "user":
        raise PrintModeInputError(f"line {line_number} must be a user message object")
    content = payload.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts: list[str] = []
        for index, item in enumerate(content, start=1):
            if (
                not isinstance(item, dict)
                or item.get("type") != "text"
                or not isinstance(item.get("text"), str)
            ):
                raise PrintModeInputError(
                    f"line {line_number} content part {index} must be a text object"
                )
            parts.append(item["text"])
        text = "".join(parts)
    else:
        raise PrintModeInputError(f"line {line_number} content must be text or text parts")
    if not text.strip():
        raise PrintModeInputError(f"line {line_number} contains an empty user message")
    if len(text) > MAX_INPUT_CHARS:
        raise PrintModeInputError(
            f"line {line_number} exceeds {MAX_INPUT_CHARS} characters"
        )
    return text


def iter_stream_messages(lines: Iterable[str]) -> Iterable[str]:
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        yield parse_stream_message(line, line_number)


class PrintEventRenderer:
    """Convert Bridge events to stable text or unified JSONL messages."""

    def __init__(
        self,
        options: PrintModeOptions,
        *,
        stdout: TextIO,
        stderr: TextIO,
    ):
        self.options = options
        self.stdout = stdout
        self.stderr = stderr
        self.answer = ""
        self._printed_text = False
        self._assistant_emitted = False
        self._tool_counter = 0
        self._pending_tools: list[tuple[str, str]] = []
        self.terminal: dict[str, Any] | None = None
        self._lock = threading.RLock()

    def begin_turn(self) -> None:
        with self._lock:
            self.answer = ""
            self._printed_text = False
            self._assistant_emitted = False
            self._tool_counter = 0
            self._pending_tools.clear()
            self.terminal = None

    def _json_line(self, payload: dict[str, Any]) -> None:
        self.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.stdout.flush()

    def _flush_assistant(self) -> None:
        if self.answer:
            self._json_line({"role": "assistant", "content": self.answer})
            self._assistant_emitted = True
            self.answer = ""

    def handle(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type", ""))
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        with self._lock:
            if event_type == "answer.reset":
                self.answer = ""
                return
            if event_type == "answer.delta":
                content = str(data.get("content", ""))
                self.answer += content
                if (
                    self.options.output_format == "text"
                    and not self.options.final_message_only
                    and content
                ):
                    self.stdout.write(content)
                    self.stdout.flush()
                    self._printed_text = True
                return
            if event_type == "tool.prepared":
                name = str(data.get("tool_name", "tool") or "tool")
                summary = str(data.get("summary", "") or "")
                arguments = data.get("arguments", {})
                if not isinstance(arguments, (dict, list)):
                    arguments = {"value": arguments}
                self._tool_counter += 1
                tool_id = f"tool-{self._tool_counter}"
                self._pending_tools.append((name, tool_id))
                if self.options.output_format == "stream-json":
                    self._flush_assistant()
                    self._json_line({
                        "role": "assistant",
                        "content": summary,
                        "tool_calls": [{
                            "type": "function",
                            "id": tool_id,
                            "function": {
                                "name": name,
                                "arguments": json.dumps(
                                    arguments,
                                    ensure_ascii=False,
                                    separators=(",", ":"),
                                ),
                            },
                        }],
                    })
                elif not self.options.final_message_only:
                    print(f"[tool] {name}: {summary}", file=self.stderr)
                return
            if event_type == "tool.completed":
                name = str(data.get("tool_name", "tool") or "tool")
                tool_id = next(
                    (identifier for pending_name, identifier in self._pending_tools if pending_name == name),
                    f"tool-{self._tool_counter + 1}",
                )
                self._pending_tools = [
                    item for item in self._pending_tools if item[1] != tool_id
                ]
                content = str(
                    data.get("content", data.get("summary", ""))
                    if data.get("success", True) is not False
                    else data.get("content", data.get("error", "tool failed"))
                )
                if self.options.output_format == "stream-json":
                    self._json_line({
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": content,
                        "is_error": data.get("success", True) is False,
                    })
                elif not self.options.final_message_only:
                    state = "done" if data.get("success", True) is not False else "failed"
                    print(f"[tool:{state}] {name}: {content}", file=self.stderr)
                return
            if event_type.startswith("operation.") and event_type in {
                "operation.completed",
                "operation.failed",
                "operation.cancelled",
                "operation.timed_out",
            }:
                self.terminal = {"type": event_type, "data": dict(data)}
                if event_type == "operation.completed":
                    final_answer = str(data.get("answer", self.answer))
                    if self.options.output_format == "stream-json":
                        if self.answer:
                            self._flush_assistant()
                        elif final_answer and not self._assistant_emitted:
                            self._json_line({"role": "assistant", "content": final_answer})
                            self._assistant_emitted = True
                    elif self.options.final_message_only:
                        self.stdout.write(final_answer)
                        if final_answer and not final_answer.endswith("\n"):
                            self.stdout.write("\n")
                        self.stdout.flush()
                    elif self._printed_text and not self.answer.endswith("\n"):
                        self.stdout.write("\n")
                        self.stdout.flush()


def _auto_answer_question(runtime: SessionRuntime, event: dict[str, Any]) -> None:
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        return
    answers: dict[str, str] = {}
    for item in questions:
        if not isinstance(item, dict):
            return
        options = item.get("options")
        if not isinstance(options, list) or not options or not isinstance(options[0], dict):
            return
        question = item.get("question")
        label = options[0].get("label")
        if not isinstance(question, str) or not isinstance(label, str):
            return
        answers[question] = label
    runtime.respond_question(
        str(event.get("session_id", "")),
        str(data.get("question_id", "")),
        answers,
        None,
    )


def _terminal_exit_code(terminal: dict[str, Any] | None) -> int:
    if terminal is None:
        return 1
    event_type = terminal["type"]
    data = terminal["data"]
    if event_type == "operation.completed":
        return 0 if data.get("status", "succeeded") != "incomplete" else 1
    code = str((data.get("error") or {}).get("code", data.get("code", "")))
    message = str((data.get("error") or {}).get("message", data.get("message", "")))
    return 75 if code in RETRYABLE_CODES or _RETRYABLE_MESSAGE.search(message) else 1


def run_print_mode(
    messages: Iterable[str],
    options: PrintModeOptions,
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    runtime_factory=None,
) -> int:
    """Process one or more messages sequentially in one isolated session."""

    if options.input_format not in INPUT_FORMATS:
        raise PrintModeInputError("input format must be text or stream-json")
    if options.output_format not in OUTPUT_FORMATS:
        raise PrintModeInputError("output format must be text or stream-json")
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    renderer = PrintEventRenderer(options, stdout=stdout, stderr=stderr)
    runtime_holder: dict[str, SessionRuntime] = {}

    def emit(event: dict[str, Any]) -> None:
        renderer.handle(event)
        if event.get("type") == "question.requested" and "runtime" in runtime_holder:
            _auto_answer_question(runtime_holder["runtime"], event)

    runtime = (
        runtime_factory(emit)
        if runtime_factory is not None
        else SessionRuntime(emit)
    )
    runtime_holder["runtime"] = runtime
    try:
        session = runtime.create_session()
        processed = 0
        for message in messages:
            if not isinstance(message, str) or not message.strip():
                raise PrintModeInputError("print mode requires a non-empty prompt")
            if len(message) > MAX_INPUT_CHARS:
                raise PrintModeInputError(
                    f"prompt exceeds {MAX_INPUT_CHARS} characters"
                )
            processed += 1
            renderer.begin_turn()
            operation = runtime.start_chat(
                session["session_id"],
                message,
                NO_TIMEOUT_MS,
                reasoning_effort=options.reasoning_effort,
                permission_mode=options.permission_mode,
                confirmation_handler=lambda _risk, _description: True,
            )
            runtime.release_operation(operation["operation_id"])
            terminal = runtime.wait_operation(operation["operation_id"])
            code = _terminal_exit_code(renderer.terminal)
            if code:
                terminal_data = (
                    renderer.terminal.get("data", {})
                    if isinstance(renderer.terminal, dict)
                    else {}
                )
                error_data = terminal.get("error") or terminal_data.get("error") or terminal_data
                message_text = str(error_data.get("message", "print operation failed"))
                print(message_text, file=stderr)
                return code
        if processed == 0:
            raise PrintModeInputError("print mode received no user messages")
        return 0
    except SessionRuntimeError as exc:
        print(exc.message, file=stderr)
        return 75 if exc.code in RETRYABLE_CODES or _RETRYABLE_MESSAGE.search(exc.message) else 1
    finally:
        runtime.shutdown()
