"""运行级 token 预算守卫（HK-4 续：budget 入中间件链）。

把"预算"从散落的事后检查（子 Agent P0-1 / 调度器 P2-7）补成一个可注册的运行级守卫：
- POST_LLM_CALL：累计本次 run 的 token。
- PRE_LLM_CALL：若累计已达上限 → block，run_tool_loop 据此中止本次 run（防失控 token 花费）。

用 contextvars 做 run 作用域（与多 Agent 并行安全）。默认不启用（budget_scope 未进入即无操作）。
"""

from __future__ import annotations

import contextvars
import json
import math
import time as _time
from contextlib import contextmanager
from dataclasses import dataclass, field

from arforge.core.hooks import HookDecision, HookEvent, get_hook_manager

_run_budget: contextvars.ContextVar = contextvars.ContextVar("arforge_run_budget", default=None)


class TokenBudgetPreflightExceeded(RuntimeError):
    """Raised before a provider call that cannot fit in the remaining budget."""


@contextmanager
def budget_scope(max_tokens: int):
    """在本次 run 期间设定 token 预算上限（<=0 表示不限）。退出自动清理。"""
    token = _run_budget.set({"used": 0, "max": int(max_tokens or 0)})
    try:
        yield
    finally:
        _run_budget.reset(token)


def current_usage() -> dict | None:
    return _run_budget.get()


def remaining_tokens() -> int | None:
    """Return the remaining run budget, or ``None`` when it is unlimited."""
    state = _run_budget.get()
    if state is None or state["max"] <= 0:
        return None
    return max(0, int(state["max"]) - int(state["used"]))


def safe_completion_allowance(
    messages: list,
    tools: list | None,
    *,
    available_tokens: int | None = None,
) -> int | None:
    """Return a conservative output allowance that keeps the call in budget.

    Provider usage includes both prompt and completion tokens. Reserving only
    the completion side can overshoot on the last call, so estimate the full
    serialized prompt/tool schema with a safety margin before invoking it.
    """
    available = remaining_tokens() if available_tokens is None else int(available_tokens)
    if available is None:
        return None
    from arforge.core.context import estimate_messages_tokens, estimate_text_tokens

    estimated_prompt = estimate_messages_tokens(messages)
    if tools:
        estimated_prompt += estimate_text_tokens(
            json.dumps(tools, ensure_ascii=False, separators=(",", ":"))
        )
    reserved_prompt = math.ceil(estimated_prompt * 1.5) + 32
    return max(0, available - reserved_prompt)


def _accumulate_hook(ctx):
    """POST_LLM_CALL：累计 usage.total_tokens 到当前 run 预算。"""
    state = _run_budget.get()
    if state is None:
        return None
    usage = (ctx.metadata or {}).get("usage") or {}
    state["used"] += int(usage.get("total_tokens", 0) or 0)
    return None


def budget_guard_hook(ctx):
    """PRE_LLM_CALL：累计 token 达上限 → block（中止本次 run）。"""
    state = _run_budget.get()
    if state is None or state["max"] <= 0:
        return None
    if state["used"] >= state["max"]:
        return HookDecision.block(f"run token budget exceeded ({state['used']}/{state['max']})")
    return None


def install_budget_hooks():
    """幂等注册预算守卫：guard→PRE_LLM_CALL(40) + accumulate→POST_LLM_CALL(40)。"""
    mgr = get_hook_manager()
    mgr.unregister(HookEvent.PRE_LLM_CALL, budget_guard_hook)
    mgr.register(HookEvent.PRE_LLM_CALL, budget_guard_hook, priority=40, name="budget_guard")
    mgr.unregister(HookEvent.POST_LLM_CALL, _accumulate_hook)
    mgr.register(HookEvent.POST_LLM_CALL, _accumulate_hook, priority=40, name="budget_accumulate")
    return mgr

# ---------------------------------------------------------------------------
# WP-04: Multi-dimensional work budget (tokens + steps + time + file count)
# ---------------------------------------------------------------------------

@dataclass
class WorkBudget:
    """Multi-dimensional budget for a single AgentRun.

    All fields default to 0 (unlimited). Set positive values to enforce limits.
    """

    max_tokens: int = 0       # 0 = unlimited
    max_steps: int = 0        # 0 = unlimited
    max_seconds: float = 0.0  # 0 = unlimited
    max_files: int = 0        # 0 = unlimited (files modified/created)

    def to_dict(self) -> dict[str, int]:
        return {
            "max_tokens": self.max_tokens,
            "max_steps": self.max_steps,
            "max_seconds": int(self.max_seconds),
            "max_files": self.max_files,
        }

    @classmethod
    def from_complexity(cls, tier: str) -> "WorkBudget":
        """Create a sensible budget based on task complexity tier."""
        budgets = {
            "simple": cls(max_tokens=50000, max_steps=10, max_seconds=300, max_files=5),
            "medium": cls(max_tokens=150000, max_steps=25, max_seconds=900, max_files=15),
            "complex": cls(max_tokens=300000, max_steps=40, max_seconds=1800, max_files=30),
        }
        return budgets.get(tier, cls())


@dataclass
class WorkBudgetTracker:
    """Runtime tracker that enforces a WorkBudget during execution."""

    budget: WorkBudget
    tokens_used: int = 0
    steps_taken: int = 0
    files_modified: int = 0
    started_at: float = 0.0
    _stopped: bool = False
    _events: list = field(default_factory=list)

    def start(self) -> None:
        self.started_at = _time.perf_counter()

    def stop(self) -> None:
        self._stopped = True

    def elapsed_seconds(self) -> float:
        if not self.started_at:
            return 0.0
        return _time.perf_counter() - self.started_at

    def add_tokens(self, count: int) -> None:
        self.tokens_used += count

    def add_step(self) -> None:
        self.steps_taken += 1

    def add_file_modification(self) -> None:
        self.files_modified += 1

    def check(self) -> str | None:
        """Return a violation message if any budget dimension is exceeded, else None."""
        b = self.budget
        if b.max_tokens > 0 and self.tokens_used >= b.max_tokens:
            return f"token budget exceeded ({self.tokens_used}/{b.max_tokens})"
        if b.max_steps > 0 and self.steps_taken >= b.max_steps:
            return f"step budget exceeded ({self.steps_taken}/{b.max_steps})"
        if b.max_seconds > 0 and self.elapsed_seconds() >= b.max_seconds:
            return f"time budget exceeded ({self.elapsed_seconds():.1f}s/{b.max_seconds:.0f}s)"
        if b.max_files > 0 and self.files_modified >= b.max_files:
            return f"file modification budget exceeded ({self.files_modified}/{b.max_files})"
        return None

    def usage_pct(self) -> float:
        """Return the highest usage percentage across all dimensions (0-100)."""
        pcts: list[float] = []
        b = self.budget
        if b.max_tokens > 0:
            pcts.append(self.tokens_used / b.max_tokens * 100)
        if b.max_steps > 0:
            pcts.append(self.steps_taken / b.max_steps * 100)
        if b.max_seconds > 0:
            pcts.append(self.elapsed_seconds() / b.max_seconds * 100)
        if b.max_files > 0:
            pcts.append(self.files_modified / b.max_files * 100)
        return max(pcts) if pcts else 0.0

    def snapshot(self) -> dict[str, int]:
        return {
            "tokens_used": self.tokens_used,
            "steps_taken": self.steps_taken,
            "files_modified": self.files_modified,
            "elapsed_seconds": int(self.elapsed_seconds()),
        }

    def log_event(self, event: str, detail: dict | None = None) -> None:
        self._events.append({
            "event": event,
            "detail": detail or {},
            "snapshot": self.snapshot(),
        })


def budget_exceeded(tracker: WorkBudgetTracker | None) -> bool:
    """Convenience: check if a tracker has exceeded its budget."""
    if tracker is None:
        return False
    return tracker.check() is not None
