"""Concurrent interactive CLI session backed by the canonical SessionRuntime."""

from __future__ import annotations

import tempfile
import threading
from pathlib import Path
from typing import Any

from arforge.cli_ui import print_error, print_info, print_ok, print_warn
from arforge.cli_workstream import CliWorkstream
from arforge.product.prompt_queue_runtime import PromptQueueRuntime
from arforge.product.session_runtime import NO_TIMEOUT_MS, SessionRuntime, SessionRuntimeError


class CliLiveSession:
    """Keep terminal input available while one normal agent operation streams."""

    def __init__(
        self,
        agent,
        state,
        *,
        lang: str,
        runtime_factory=None,
    ) -> None:
        self.agent = agent
        self.state = state
        self.lang = "zh" if lang == "zh" else "en"
        self._lock = threading.RLock()
        self._renderers: dict[str, CliWorkstream] = {}
        self._prompts: dict[str, str] = {}
        self._pending_question: dict[str, Any] | None = None
        self._pending_confirmation: dict[str, Any] | None = None
        self._temporary = tempfile.TemporaryDirectory(prefix="arforge-cli-queue-")
        queue = PromptQueueRuntime(Path(self._temporary.name) / "queue.db")
        factory = runtime_factory or (
            lambda emit: SessionRuntime(
                emit,
                agent_factory=lambda: self.agent,
                prompt_queue=queue,
            )
        )
        self.runtime = factory(self._handle_event)
        self.session = self.runtime.create_session()

    @property
    def session_id(self) -> str:
        return str(self.session["session_id"])

    @property
    def active(self) -> bool:
        return self.runtime.active_operation_id(self.session_id) is not None

    def accepts_control_input(self, text: str) -> bool:
        stripped = text.strip().casefold()
        with self._lock:
            return bool(
                self._pending_question
                or self._pending_confirmation
                or (self.active and stripped.startswith(("/steer ", "/cancel")))
            )

    def submit(self, text: str) -> dict[str, Any]:
        value = str(text or "").strip()
        if not value:
            raise SessionRuntimeError("INVALID_PARAMS", "input must be non-empty")
        with self._lock:
            if self._pending_confirmation is not None:
                return self._answer_confirmation(value)
            if self._pending_question is not None:
                return self._answer_question(value)

        active_id = self.runtime.active_operation_id(self.session_id)
        lowered = value.casefold()
        if active_id is not None and lowered.startswith("/steer "):
            result = self.runtime.steer_operation(active_id, value.split(maxsplit=1)[1])
            print_ok(
                f"Steering accepted ({result['pending']} pending)."
                if self.lang == "en"
                else f"已接收运行引导（待应用 {result['pending']} 条）。"
            )
            return {"kind": "steer", **result}
        if active_id is not None and lowered == "/cancel":
            result = self.runtime.cancel_operation(active_id)
            print_warn("Cancellation requested." if self.lang == "en" else "已请求取消当前运行。")
            return {"kind": "cancel", **result}
        if active_id is not None:
            queued = self.runtime.enqueue_chat(
                self.session_id,
                value,
                NO_TIMEOUT_MS,
                reasoning_effort=self.state.get("effort", "medium"),
                permission_mode=self.state.get("permission_mode"),
            )
            count = self.runtime.list_queued_chats(self.session_id)["count"]
            print_info(
                f"Queued follow-up #{count}: {value[:80]}"
                if self.lang == "en"
                else f"已加入后续队列 #{count}：{value[:80]}"
            )
            return {"kind": "queued", **queued}

        operation = self.runtime.start_chat(
            self.session_id,
            value,
            NO_TIMEOUT_MS,
            reasoning_effort=self.state.get("effort", "medium"),
            permission_mode=self.state.get("permission_mode"),
            confirmation_handler=self._request_confirmation,
        )
        operation_id = str(operation["operation_id"])
        with self._lock:
            self._prompts[operation_id] = value
            self._renderers[operation_id] = self._new_renderer(value)
        self.runtime.release_operation(operation_id)
        return {"kind": "started", **operation}

    def shutdown(self) -> None:
        active_id = self.runtime.active_operation_id(self.session_id)
        if active_id is not None:
            self.runtime.cancel_operation(active_id)
        with self._lock:
            pending = self._pending_confirmation
            if pending is not None:
                pending["answer"] = False
                pending["event"].set()
                self._pending_confirmation = None
        self.runtime.shutdown()
        self._temporary.cleanup()

    def _new_renderer(self, prompt: str) -> CliWorkstream:
        renderer = CliWorkstream(
            lang=self.lang,
            reasoning_effort=self.state.get("effort", "medium"),
            permission_mode=self.state.get("permission_mode", "autoApprove"),
        )
        renderer.begin(prompt)
        return renderer

    def _renderer(self, event: dict[str, Any]) -> CliWorkstream:
        operation_id = str(event.get("operation_id", ""))
        with self._lock:
            renderer = self._renderers.get(operation_id)
            if renderer is None:
                prompt = self._prompts.get(operation_id, "")
                data = event.get("data") if isinstance(event.get("data"), dict) else {}
                if event.get("type") == "chat.queued.started":
                    prompt = str(data.get("input", ""))
                renderer = self._new_renderer(prompt)
                self._renderers[operation_id] = renderer
            return renderer

    def _handle_event(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type", ""))
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        renderer = self._renderer(event)
        if event_type == "reasoning.started":
            renderer.reasoning_started()
        elif event_type == "reasoning.completed":
            renderer.reasoning_completed(data.get("reasoning"))
        elif event_type == "answer.reset":
            renderer.answer_reset()
        elif event_type == "answer.delta":
            renderer.answer_delta(str(data.get("content", "")))
        elif event_type == "tool.prepared":
            renderer.tool_started(
                str(data.get("tool_name", "tool")),
                summary=str(data.get("summary", "")),
                arguments=data.get("arguments") if isinstance(data.get("arguments"), dict) else {},
            )
        elif event_type == "tool.completed":
            renderer.tool_completed(
                str(data.get("tool_name", "tool")),
                success=data.get("success", True) is not False,
                summary=str(data.get("content", data.get("summary", data.get("error", "")))),
            )
        elif event_type == "artifact.created":
            artifact = data.get("artifact") if isinstance(data.get("artifact"), dict) else {}
            renderer.artifact_created(
                str(artifact.get("path", "")),
                str(artifact.get("source", "file.write")),
            )
        elif event_type == "question.requested":
            self._show_question(event)
        elif event_type == "operation.completed":
            if data.get("status", "succeeded") == "incomplete":
                renderer.incomplete(
                    reason=str((data.get("meta") or {}).get("completion_status", "step budget reached")),
                    answer=str(data.get("answer", "")),
                )
            else:
                renderer.complete(
                    answer=str(data.get("answer", "")),
                    usage=(data.get("meta") or {}).get("usage"),
                    agents=int((data.get("meta") or {}).get("agents_used", 1) or 1),
                )
            self._settle_renderer(event)
        elif event_type in {"operation.cancelled", "operation.timed_out"}:
            renderer.interrupted()
            self._settle_renderer(event)
        elif event_type == "operation.failed":
            renderer.stop()
            error = data.get("error") if isinstance(data.get("error"), dict) else data
            print_error(str(error.get("message", "operation failed")))
            self._settle_renderer(event)

    def _settle_renderer(self, event: dict[str, Any]) -> None:
        operation_id = str(event.get("operation_id", ""))
        with self._lock:
            self._renderers.pop(operation_id, None)
            self._prompts.pop(operation_id, None)

    def _show_question(self, event: dict[str, Any]) -> None:
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        questions = data.get("questions")
        if not isinstance(questions, list) or not questions:
            return
        with self._lock:
            self._pending_question = {
                "question_id": str(data.get("question_id", "")),
                "questions": questions,
            }
        print()
        print_info(
            "Answer the requested question with an option number or label."
            if self.lang == "en"
            else "请用选项编号或标签回答以下问题。"
        )
        for q_index, question in enumerate(questions, start=1):
            print(f"  {q_index}. {question.get('question', '')}")
            for index, option in enumerate(question.get("options") or [], start=1):
                print(f"     {index}) {option.get('label', '')}")

    def _answer_question(self, value: str) -> dict[str, Any]:
        pending = self._pending_question
        if pending is None:
            raise SessionRuntimeError("QUESTION_NOT_FOUND", "no question is pending")
        choices = [item.strip() for item in value.split(",")]
        questions = pending["questions"]
        if len(choices) not in {1, len(questions)}:
            raise SessionRuntimeError(
                "INVALID_PARAMS",
                "provide one choice per question, separated by commas",
            )
        if len(choices) == 1 and len(questions) > 1:
            choices *= len(questions)
        answers: dict[str, str] = {}
        for question, choice in zip(questions, choices):
            options = question.get("options") or []
            label = choice
            if choice.isdigit() and 1 <= int(choice) <= len(options):
                label = str(options[int(choice) - 1].get("label", ""))
            valid_labels = {str(item.get("label", "")) for item in options}
            if label not in valid_labels:
                raise SessionRuntimeError(
                    "INVALID_PARAMS",
                    f"unknown option for: {question.get('question', '')}",
                )
            answers[str(question.get("question", ""))] = label
        result = self.runtime.respond_question(
            self.session_id,
            pending["question_id"],
            answers,
            None,
        )
        self._pending_question = None
        print_ok("Answer submitted." if self.lang == "en" else "已提交回答。")
        return {"kind": "question", **result}

    def _request_confirmation(self, risk: str, description: str) -> bool:
        event = threading.Event()
        record = {
            "risk": risk,
            "description": description,
            "answer": False,
            "event": event,
        }
        with self._lock:
            self._pending_confirmation = record
        print_warn(
            f"Approval required [{risk}]: {description}. Type yes or no."
            if self.lang == "en"
            else f"需要审批 [{risk}]：{description}。请输入 yes 或 no。"
        )
        event.wait()
        return bool(record["answer"])

    def _answer_confirmation(self, value: str) -> dict[str, Any]:
        pending = self._pending_confirmation
        if pending is None:
            raise SessionRuntimeError("APPROVAL_NOT_FOUND", "no approval is pending")
        normalized = value.strip().casefold()
        if normalized not in {"y", "yes", "n", "no", "是", "否"}:
            raise SessionRuntimeError("INVALID_PARAMS", "answer yes or no")
        approved = normalized in {"y", "yes", "是"}
        pending["answer"] = approved
        pending["event"].set()
        self._pending_confirmation = None
        print_ok(
            ("Approved." if approved else "Denied.")
            if self.lang == "en"
            else ("已批准。" if approved else "已拒绝。")
        )
        return {"kind": "confirmation", "approved": approved}
