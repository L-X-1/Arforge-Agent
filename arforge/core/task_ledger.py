"""G4：自驱任务清单（TodoWrite 式）。

agentic 循环中的模型用它把复杂任务拆成结构化执行计划：列出若干步骤，
并在推进时逐步把步骤标记 in_progress / completed。CLI 实时渲染，让长任务
进度可见、不迷路。对标业界 TodoWrite 式任务清单。

与 ``arforge/tools/task_tools.py``（用户级、写 tasks.json 的持久化待办）互不相干：
本模块只活在内存（会话级单例），不落盘，供 agent 自我编排长任务用。

设计要点：
  - 覆盖式更新（``replace``）——与 TodoWrite 语义一致，每次传入完整计划。
  - 线程安全（RLock）——并行工具执行时不竞争。
  - 会话级单例 + ``reset_task_ledger`` —— 每次 run 从空开始，并便于测试隔离。
  - ``parse_plan`` 强容错 —— 兼容模型输出的多种 JSON 形态。
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass

PENDING = "pending"
IN_PROGRESS = "in_progress"
COMPLETED = "completed"
_VALID_STATUS = (PENDING, IN_PROGRESS, COMPLETED)

_ICON = {PENDING: "○", IN_PROGRESS: "▶", COMPLETED: "✔"}


@dataclass
class TaskItem:
    """计划中的单个步骤。"""

    content: str
    status: str = PENDING

    def to_dict(self) -> dict:
        return {"content": self.content, "status": self.status}


class TaskLedger:
    """线程安全的会话级执行计划。覆盖式更新（TodoWrite 语义）。"""

    def __init__(self) -> None:
        self._items: list[TaskItem] = []
        self._lock = threading.RLock()

    def replace(self, items: list[TaskItem]) -> None:
        """用新列表整体覆盖当前计划（清洗空内容、非法状态）。"""
        cleaned: list[TaskItem] = []
        for it in items:
            content = (it.content or "").strip()
            if not content:
                continue
            status = it.status if it.status in _VALID_STATUS else PENDING
            cleaned.append(TaskItem(content=content, status=status))
        with self._lock:
            self._items = cleaned

    def items(self) -> list[TaskItem]:
        with self._lock:
            return list(self._items)

    def to_list(self) -> list[dict]:
        return [it.to_dict() for it in self.items()]

    def is_empty(self) -> bool:
        with self._lock:
            return not self._items

    def stats(self) -> dict:
        items = self.items()
        done = sum(1 for it in items if it.status == COMPLETED)
        in_prog = sum(1 for it in items if it.status == IN_PROGRESS)
        return {
            "total": len(items),
            "completed": done,
            "in_progress": in_prog,
            "pending": len(items) - done - in_prog,
        }

    def render(self) -> str:
        """渲染为人类可读清单：✔ 完成 / ▶ 进行中 / ○ 待办。"""
        items = self.items()
        if not items:
            return "  (计划为空)"
        st = self.stats()
        lines = [f"  执行计划 ({st['completed']}/{st['total']} 完成)"]
        for it in items:
            lines.append(f"    {_ICON.get(it.status, '○')} {it.content}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# 会话级单例
# ---------------------------------------------------------------------------

_ledger = None
_singleton_lock = threading.Lock()


def get_task_ledger() -> TaskLedger:
    global _ledger
    if _ledger is None:
        with _singleton_lock:
            if _ledger is None:
                _ledger = TaskLedger()
    return _ledger


def reset_task_ledger() -> None:
    """清空单例：每次 agentic run 开始时调用，亦用于测试隔离。"""
    global _ledger
    with _singleton_lock:
        _ledger = TaskLedger()


# ---------------------------------------------------------------------------
# 解析模型输入（强容错）
# ---------------------------------------------------------------------------

# 状态别名 → 规范状态
_STATUS_ALIASES = {
    "doing": IN_PROGRESS,
    "active": IN_PROGRESS,
    "in progress": IN_PROGRESS,
    "wip": IN_PROGRESS,
    "started": IN_PROGRESS,
    "done": COMPLETED,
    "complete": COMPLETED,
    "finished": COMPLETED,
    "completed": COMPLETED,
    "todo": PENDING,
    "open": PENDING,
    "not_started": PENDING,
    "pending": PENDING,
}

# 内容键 / 状态键的兼容别名
_CONTENT_KEYS = ("content", "task", "step", "title", "name", "text")
_STATUS_KEYS = ("status", "state")
# 顶层若被包进对象，尝试这些数组键
_LIST_KEYS = ("plan", "tasks", "todos", "steps", "items")


def _normalize_status(raw: str) -> str:
    s = str(raw or "").strip().lower().replace("-", "_")
    if s in _VALID_STATUS:
        return s
    return _STATUS_ALIASES.get(s, _STATUS_ALIASES.get(s.replace("_", " "), PENDING))


def parse_plan(plan_json: str) -> list[TaskItem]:
    """把模型传入的计划 JSON 解析成 TaskItem 列表（容错）。

    接受形如 ``[{"content": "...", "status": "pending"}, ...]`` 的 JSON 数组字符串。
    兼容：被包进 ``{"plan": [...]}`` / ``{"tasks": [...]}`` 等；每项也兼容用
    ``task`` / ``step`` / ``title`` 作内容键、``state`` 作状态键、或直接是纯字符串。
    解析失败抛 ``ValueError``（注册表会转成失败结果回灌模型纠正）。
    """
    if not plan_json or not str(plan_json).strip():
        raise ValueError("plan_json 为空")
    try:
        data = json.loads(plan_json)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError(f"plan_json 不是合法 JSON: {exc}") from exc

    if isinstance(data, dict):
        for key in _LIST_KEYS:
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            data = [data]  # 单个对象 → 单步
    if not isinstance(data, list):
        raise ValueError("plan_json 顶层应是数组或可识别的计划对象")

    items: list[TaskItem] = []
    for raw in data:
        if isinstance(raw, str):
            content, status = raw, PENDING
        elif isinstance(raw, dict):
            content = next((raw[k] for k in _CONTENT_KEYS if raw.get(k)), "")
            status = next((raw[k] for k in _STATUS_KEYS if raw.get(k)), PENDING)
        else:
            continue
        content = str(content).strip()
        if not content:
            continue
        items.append(TaskItem(content=content, status=_normalize_status(status)))

    if not items:
        raise ValueError("plan_json 未解析出任何有效步骤")
    return items
