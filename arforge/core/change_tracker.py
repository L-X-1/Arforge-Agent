"""G10/G11 基础设施：本次 run 的改动文件登记。

POST_TOOL_USE 时记录 write_file / edit_file / create_file 成功触及的文件，供：
  - G10 交付前质量门禁（verify_work）汇总校验
  - G11 回归保护（定位受影响测试）
  - 任务报告 modified_files

会话级单例 + reset（每轮重置/测试隔离），与 ``task_ledger`` 同样的模式。
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import threading

from arforge.core.hooks import HookEvent, get_hook_manager

# 视为"改动文件"的写工具（create_file 创建空文件也算一次改动）
_OFFICE_SUFFIXES = {
    "write_docx": ".docx",
    "write_xlsx": ".xlsx",
    "write_pptx": ".pptx",
    "write_pdf": ".pdf",
}
_WRITE_TOOLS = {"write_file", "edit_file", "create_file", "delete_file", *_OFFICE_SUFFIXES}


class ChangeTracker:
    """线程安全、保序去重的改动文件登记。"""

    def __init__(self) -> None:
        self._files: list[str] = []
        self._lock = threading.RLock()

    def record(self, filename: str) -> None:
        if not filename:
            return
        with self._lock:
            if filename not in self._files:
                self._files.append(filename)

    def changed(self) -> list[str]:
        with self._lock:
            return list(self._files)

    def is_empty(self) -> bool:
        with self._lock:
            return not self._files


# ---------------------------------------------------------------------------
# 会话级单例
# ---------------------------------------------------------------------------

_TRACKER: ContextVar[ChangeTracker | None] = ContextVar(
    "arforge_change_tracker",
    default=None,
)


def get_change_tracker() -> ChangeTracker:
    """Return the tracker for the current logical execution context."""
    tracker = _TRACKER.get()
    if tracker is None:
        tracker = ChangeTracker()
        _TRACKER.set(tracker)
    return tracker


def reset_change_tracker() -> None:
    """清空登记：每次 agentic run 开始时调用，亦用于测试隔离。"""
    _TRACKER.set(ChangeTracker())


@contextmanager
def change_tracker_scope():
    """Create isolated tracking state and restore any enclosing execution."""
    token = _TRACKER.set(ChangeTracker())
    try:
        yield
    finally:
        _TRACKER.reset(token)


# ---------------------------------------------------------------------------
# POST_TOOL_USE hook
# ---------------------------------------------------------------------------


def record_change_hook(ctx) -> None:
    """写文件成功后登记 filename。"""
    if ctx.tool_name not in _WRITE_TOOLS:
        return
    result = ctx.tool_result
    if result is None or not getattr(result, "success", False):
        return
    filename = (ctx.tool_args or {}).get("filename")
    if filename:
        suffix = _OFFICE_SUFFIXES.get(ctx.tool_name)
        if suffix:
            from pathlib import Path

            if Path(str(filename)).suffix == "":
                filename = f"{filename}{suffix}"
        get_change_tracker().record(filename)


def install_change_tracker_hook() -> None:
    """安装改动登记 hook（POST_TOOL_USE，观察类，priority=70）。"""
    mgr = get_hook_manager()
    if "change_tracker" in mgr.handler_names(HookEvent.POST_TOOL_USE):
        return
    mgr.register(HookEvent.POST_TOOL_USE, record_change_hook, priority=70, name="change_tracker")
