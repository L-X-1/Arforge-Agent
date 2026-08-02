"""v1-1.1：结构化任务报告。

POST_TOOL_USE 收集本次 run 的活动，任务结束产出结构化报告，让用户清楚 agent
**读了哪些 / 改了哪些 / 跑了什么命令 / 交付校验结果**，而不只是 token/成本：
  - explored_files：读/摘要过的文件（只读探索工具）
  - modified_files：改过的文件（复用 change_tracker）
  - commands_run：run_cmd 的命令 + 成功与否
  - verifications：verify_work 的结论
  - final_answer

CLI 末尾打印精简版；``ARFORGE_RUN_REPORT=<path>`` 时另落盘 JSON。会话级单例 + reset。
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import threading
from typing import Iterator

from arforge.core.hooks import HookEvent, get_hook_manager

_EXPLORE_TOOLS = {
    "code_search",
    "code_read",
    "read_file",
    "list_files",
    "list_code_files",
    "code_summary",
    "csv_preview",
    "json_pretty",
}
_CMD_TOOLS = {"run_cmd", "run_script"}
_VERIFY_TOOLS = {"verify_work"}


class RunReport:
    """会话级任务活动收集器。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._explored: list[str] = []
        self._commands: list[dict] = []
        self._verifications: list[str] = []
        self._tool_calls = 0
        self.final_answer = ""

    def record_tool(self, tool_name, tool_args, result) -> None:
        success = getattr(result, "success", False)
        args = tool_args or {}
        with self._lock:
            self._tool_calls += 1
            if tool_name in _EXPLORE_TOOLS:
                fn = args.get("filename")
                if fn and fn not in self._explored:
                    self._explored.append(fn)
            elif tool_name in _CMD_TOOLS:
                cmd = args.get("command", "")
                if cmd:
                    self._commands.append({"command": cmd, "success": success})
            elif tool_name in _VERIFY_TOOLS:
                out = getattr(result, "output", "") or ""
                first = out.splitlines()[0] if out else ""
                if first:
                    self._verifications.append(first)

    def set_final_answer(self, answer) -> None:
        with self._lock:
            self.final_answer = answer or ""

    @staticmethod
    def _modified() -> list[str]:
        try:
            from arforge.core.change_tracker import get_change_tracker

            return get_change_tracker().changed()
        except Exception:  # noqa: BLE001
            return []

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "explored_files": list(self._explored),
                "modified_files": self._modified(),
                "commands_run": list(self._commands),
                "verifications": list(self._verifications),
                "tool_calls": self._tool_calls,
                "final_answer": self.final_answer,
            }

    def render(self, lang: str | None = None) -> str:
        from arforge.i18n import t

        d = self.to_dict()
        lines = [t("code.report_label", lang)]
        if d["explored_files"]:
            lines.append(f"  {t('code.report_explored', lang, n=len(d['explored_files']))}: " + "、".join(d["explored_files"]))
        if d["modified_files"]:
            lines.append(f"  {t('code.report_modified', lang, n=len(d['modified_files']))}: " + "、".join(d["modified_files"]))
        if d["commands_run"]:
            lines.append(f"  {t('code.report_commands', lang, n=len(d['commands_run']))}:")
            for c in d["commands_run"]:
                lines.append(f"    {'✔' if c['success'] else '✖'} {c['command']}")
        if d["verifications"]:
            lines.append(f"  {t('code.report_verify', lang)}: " + "; ".join(d["verifications"]))
        if len(lines) == 1:
            lines.append(t("code.report_empty", lang))
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# 会话级单例
# ---------------------------------------------------------------------------

_REPORT: ContextVar[RunReport | None] = ContextVar("arforge_run_report", default=None)


def get_run_report() -> RunReport:
    """Return the report bound to the current logical execution context."""
    report = _REPORT.get()
    if report is None:
        report = RunReport()
        _REPORT.set(report)
    return report


def reset_run_report() -> None:
    """Replace the current execution's report without affecting other sessions."""
    _REPORT.set(RunReport())


@contextmanager
def run_report_scope() -> Iterator[None]:
    """Create a fresh report for a nested execution and restore its parent."""
    token = _REPORT.set(RunReport())
    try:
        yield
    finally:
        _REPORT.reset(token)


def _record_hook(ctx) -> None:
    get_run_report().record_tool(ctx.tool_name, ctx.tool_args, ctx.tool_result)


def install_run_report_hook() -> None:
    """安装任务报告收集 hook（POST_TOOL_USE，观察类，priority=60）。"""
    manager = get_hook_manager()
    if "run_report" in manager.handler_names(HookEvent.POST_TOOL_USE):
        return
    manager.register(HookEvent.POST_TOOL_USE, _record_hook, priority=60, name="run_report")
