"""Compact streaming workbench renderer for the Arforge terminal."""

from __future__ import annotations

import json
import sys
import threading
import time
from collections.abc import Callable
from typing import Any, TextIO

from arforge.cli_ui import accent, bold, dim, error, muted, ok, supports_color, terminal_width, warn


_EFFORT_LABELS = {
    "zh": {"low": "低深度思考", "medium": "中等深度思考", "high": "高深度思考", "ultra": "超高深度思考"},
    "en": {"low": "low-depth thinking", "medium": "medium-depth thinking", "high": "high-depth thinking", "ultra": "ultra-depth thinking"},
}

_SECTION_LABELS = {
    "zh": {
        "understanding": "理解",
        "thinking": "思考",
        "evidence": "证据",
        "reflection": "复核",
    },
    "en": {
        "understanding": "Understanding",
        "thinking": "Thinking",
        "evidence": "Evidence",
        "reflection": "Review",
    },
}


def _write(stream: TextIO, text: str = "", *, end: str = "\n", flush: bool = False) -> None:
    stream.write(text + end)
    if flush:
        stream.flush()


def _summary_from_args(arguments: Any) -> str:
    if not isinstance(arguments, dict):
        return ""
    for key in ("filename", "path", "file_path", "query", "command", "cmd", "url"):
        value = arguments.get(key)
        if value not in (None, ""):
            return str(value)
    if not arguments:
        return ""
    try:
        return json.dumps(arguments, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return str(arguments)


def _clean_detail(value: Any, limit: int = 240) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def _tool_action(name: str, lang: str) -> str:
    lowered = name.casefold()
    zh = lang == "zh"
    if lowered.startswith(("read", "list", "search", "glob", "file_state")):
        return "探索" if zh else "Explore"
    if lowered.startswith(("write", "edit", "create", "delete", "patch")):
        return "编辑" if zh else "Edit"
    if lowered.startswith(("run", "exec", "shell", "terminal")):
        return "执行" if zh else "Run"
    if lowered.startswith(("verify", "check", "lint", "test")):
        return "验证" if zh else "Verify"
    if lowered.startswith(("web", "fetch", "browse")):
        return "搜索" if zh else "Search"
    return "调用" if zh else "Tool"


def _usage_tokens(usage: Any) -> int | None:
    if usage is None:
        return None
    if isinstance(usage, dict):
        for key in ("total_tokens", "tokens"):
            value = usage.get(key)
            if isinstance(value, (int, float)):
                return int(value)
        prompt = usage.get("prompt_tokens", usage.get("input_tokens", 0))
        completion = usage.get("completion_tokens", usage.get("output_tokens", 0))
        if isinstance(prompt, (int, float)) and isinstance(completion, (int, float)):
            total = int(prompt) + int(completion)
            return total or None
        return None
    value = getattr(usage, "total_tokens", None)
    if isinstance(value, (int, float)):
        return int(value)
    return None


class CliWorkstream:
    """Render a single terminal turn without owning any agent behavior."""

    def __init__(
        self,
        *,
        lang: str = "en",
        reasoning_effort: str = "medium",
        permission_mode: str = "acceptEdits",
        stream: TextIO | None = None,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.lang = "zh" if lang == "zh" else "en"
        from arforge.reasoning.effort import normalize_reasoning_effort

        self.reasoning_effort = normalize_reasoning_effort(reasoning_effort)
        self.permission_mode = permission_mode or "acceptEdits"
        self.stream = stream or sys.stdout
        self.clock = clock
        self.started_at = self.clock()
        self.thought_started_at: float | None = None
        self.answer_started = False
        self.answer = ""
        self._status_thread: threading.Thread | None = None
        self._status_running = False
        self._status_lock = threading.Lock()
        self._event_lock = threading.RLock()
        self._tool_rows: dict[tuple[str, int], str] = {}

    @property
    def effort_label(self) -> str:
        return _EFFORT_LABELS[self.lang][self.reasoning_effort]

    def begin(self, prompt: str | None = None) -> None:
        if prompt:
            width = max(24, min(terminal_width(), 100))
            visible = prompt.replace("\n", " ").strip()
            if len(visible) > width - 6:
                visible = visible[: width - 9].rstrip() + "..."
            _write(self.stream, dim("─" * width))
            _write(self.stream, f"  {bold('❯')} {visible}")
            _write(self.stream, dim("─" * width))
        self.reasoning_started()

    def reasoning_started(self) -> None:
        if self.thought_started_at is not None:
            return
        self.thought_started_at = self.clock()
        if self._can_animate():
            self._status_running = True
            self._status_thread = threading.Thread(target=self._animate_status, daemon=True)
            self._status_thread.start()
        else:
            label = "思考中" if self.lang == "zh" else "Thinking"
            _write(self.stream, f"  {accent('✦')} {dim(f'{label} · {self.effort_label}')}")

    def reasoning_completed(self, reasoning: dict[str, Any] | None = None) -> None:
        if self.thought_started_at is None:
            self.thought_started_at = self.started_at
        duration = max(0.0, self.clock() - self.thought_started_at)
        self._stop_status()
        label = "思考" if self.lang == "zh" else "Thought"
        suffix = "秒" if self.lang == "zh" else "s"
        _write(self.stream, f"  {accent('✦')} {dim(f'{label} {duration:.1f}{suffix} · {self.effort_label}')}")
        if self.reasoning_effort not in {"high", "ultra"} or not reasoning:
            self.thought_started_at = None
            return
        sections = [
            (key, str(reasoning.get(key, "") or "").strip())
            for key in ("understanding", "thinking", "evidence", "reflection")
        ]
        visible = [(key, text) for key, text in sections if text]
        for index, (key, text) in enumerate(visible):
            branch = "└─" if index == len(visible) - 1 else "├─"
            title = _SECTION_LABELS[self.lang].get(key, key)
            _write(self.stream, f"    {muted(branch)} {dim(title)}")
            excerpt = text if len(text) <= 600 else text[:597].rstrip() + "..."
            for line in excerpt.splitlines() or [excerpt]:
                _write(self.stream, f"       {dim(line)}")
        self.thought_started_at = None

    def tool_started(
        self,
        tool_name: str,
        *,
        summary: str = "",
        arguments: dict[str, Any] | None = None,
        iteration: int = 0,
    ) -> None:
        self._stop_status()
        name = tool_name or ("工具" if self.lang == "zh" else "tool")
        detail = _clean_detail(summary or _summary_from_args(arguments))
        action = _tool_action(name, self.lang)
        self._tool_rows[(name, iteration)] = detail
        _write(self.stream, f"  {accent('●')} {bold(f'{action}({name})')}")
        if detail:
            _write(self.stream, f"    {muted('├─')} {dim(detail)}")

    def tool_completed(
        self,
        tool_name: str,
        *,
        success: bool,
        summary: str = "",
        iteration: int = 0,
    ) -> None:
        key = (tool_name, iteration)
        known = self._tool_rows.get(key, "")
        if key not in self._tool_rows:
            self.tool_started(tool_name, summary=summary, iteration=iteration)
        state = ("完成" if success else "失败") if self.lang == "zh" else ("done" if success else "failed")
        symbol = ok("✓") if success else error("×")
        detail = _clean_detail(summary or known)
        suffix = f" · {detail}" if detail else ""
        _write(self.stream, f"    {muted('└─')} {symbol} {dim(state + suffix)}")

    def artifact_created(self, path: str, source: str = "file.write") -> None:
        label = "已创建" if self.lang == "zh" else "created"
        _write(self.stream, f"  {ok('●')} {dim(f'{source} -> {label}')} {path}")

    def phase_started(self, phase: str, *, detail: str = "") -> None:
        """Render a multi-agent pipeline phase without exposing internal prompts."""
        with self._event_lock:
            self._stop_status()
            label = {
                "decompose": "Decompose",
                "dispatch": "Dispatch",
                "evaluate": "Evaluate",
                "merge": "Merge",
            }.get(phase, phase.title())
            suffix = f" · {_clean_detail(detail)}" if detail else ""
            _write(self.stream, f"  {accent('◆')} {bold(label)}{dim(suffix)}")

    def agent_started(self, role: str, *, task_id: str = "") -> None:
        """Render an observable sub-agent start event."""
        with self._event_lock:
            self._stop_status()
            suffix = f" · {task_id}" if task_id else ""
            _write(self.stream, f"    {accent('●')} {bold(role)}{dim(suffix)}")

    def agent_completed(
        self,
        role: str,
        *,
        success: bool,
        elapsed_ms: int = 0,
        error_text: str = "",
    ) -> None:
        """Render a sub-agent terminal event with bounded failure details."""
        with self._event_lock:
            state = "done" if success else "failed"
            symbol = ok("✓") if success else error("×")
            elapsed = f" · {elapsed_ms / 1000:.1f}s" if elapsed_ms else ""
            detail = f" · {_clean_detail(error_text)}" if error_text else ""
            _write(self.stream, f"      {symbol} {dim(state + elapsed + detail)}")

    def agent_tool_event(
        self,
        role: str,
        tool_name: str,
        *,
        started: bool,
        success: bool = True,
        detail: str = "",
    ) -> None:
        """Render role-qualified tool activity from parallel workers."""
        with self._event_lock:
            if started:
                _write(
                    self.stream,
                    f"      {muted('├─')} {dim(role)} · {_tool_action(tool_name, self.lang)}({tool_name})",
                )
                return
            symbol = ok("✓") if success else error("×")
            suffix = f" · {_clean_detail(detail)}" if detail else ""
            _write(self.stream, f"      {muted('└─')} {symbol}{dim(suffix)}")

    def answer_reset(self) -> None:
        if not self.answer:
            return
        self.answer = ""
        self.answer_started = False
        label = "候选答案已重置，继续验证" if self.lang == "zh" else "Candidate answer reset; continuing verification"
        _write(self.stream, f"\n  {warn('↻')} {dim(label)}")

    def answer_delta(self, chunk: str) -> None:
        if not chunk:
            return
        self._stop_status()
        if not self.answer_started:
            self.answer_started = True
            _write(self.stream)
        _write(self.stream, chunk, end="", flush=True)
        self.answer += chunk

    def complete(
        self,
        *,
        answer: str = "",
        duration: float | None = None,
        usage: Any = None,
        agents: int = 1,
    ) -> None:
        self._stop_status()
        if answer and not self.answer:
            self.answer_delta(answer)
        if self.answer_started and not self.answer.endswith("\n"):
            _write(self.stream)
        elapsed = max(0.0, duration if duration is not None else self.clock() - self.started_at)
        worked = "工作完成" if self.lang == "zh" else "Worked"
        suffix = "秒" if self.lang == "zh" else "s"
        tokens = _usage_tokens(usage)
        token_part = f" · {tokens:,} tokens" if tokens is not None else ""
        _write(self.stream, f"\n  {accent('✦')} {dim(f'{worked} {elapsed:.1f}{suffix}{token_part}')}")
        self.footer(agents=agents)

    def interrupted(self) -> None:
        self._stop_status()
        label = "已中断" if self.lang == "zh" else "Interrupted"
        _write(self.stream, f"\n  {warn('■')} {label}")
        self.footer()

    def incomplete(
        self,
        *,
        reason: str = "",
        answer: str = "",
        agents: int = 1,
    ) -> None:
        """Render a terminal outcome that must not be mistaken for success."""
        self._stop_status()
        if answer and not self.answer:
            self.answer_delta(answer)
        if self.answer_started and not self.answer.endswith("\n"):
            _write(self.stream)
        label = "任务未完成" if self.lang == "zh" else "Task incomplete"
        detail = f": {reason}" if reason else ""
        _write(self.stream, f"\n  {warn('■')} {label}{detail}")
        self.footer(agents=agents)

    def stop(self) -> None:
        """Stop any active live status without printing a terminal result."""
        self._stop_status()

    def footer(self, *, agents: int = 1) -> None:
        width = max(24, min(terminal_width(), 100))
        mode_label = {
            "plan": "plan mode",
            "acceptEdits": "accept edits",
            "autoApprove": "auto approve",
            "auto": "auto mode",
            "fullAccess": "full access",
        }.get(self.permission_mode, self.permission_mode)
        interrupt = "esc/Ctrl+C 中断" if self.lang == "zh" else "esc/Ctrl+C to interrupt"
        agent_label = f"{agents} 智能体" if self.lang == "zh" else f"{agents} agent"
        _write(self.stream, dim("─" * width))
        _write(
            self.stream,
            f"  {accent('››')} {dim(mode_label)}  {muted('·')}  {dim(interrupt)}"
            f"  {muted('·')}  {dim(agent_label)}  {muted('·')}  {dim(self.effort_label)}",
        )

    def _can_animate(self) -> bool:
        return (
            self.stream is sys.stdout
            and hasattr(self.stream, "isatty")
            and self.stream.isatty()
            and supports_color()
        )

    def _animate_status(self) -> None:
        label = "思考中" if self.lang == "zh" else "Thinking"
        while self._status_running:
            elapsed = max(0.0, self.clock() - (self.thought_started_at or self.started_at))
            text = f"  {accent('✦')} {dim(f'{label} {elapsed:.0f}s · {self.effort_label}')}"
            with self._status_lock:
                self.stream.write("\r\033[2K" + text)
                self.stream.flush()
            time.sleep(0.2)

    def _stop_status(self) -> None:
        self._status_running = False
        if self._status_thread is not None:
            self._status_thread.join(timeout=0.5)
            self._status_thread = None
            with self._status_lock:
                self.stream.write("\r\033[2K")
                self.stream.flush()
