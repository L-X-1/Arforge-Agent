"""事件钩子中间件总线（HK-1）。

把横切关注点（权限、上下文压缩、审计、可观测…）从主循环解耦为可注册的"中间件链"：
run_tool_loop 等在固定时点 fire 事件；各模块以 handler 形式挂上去，无需改动主循环。

两类 handler：
- 门控类（PRE_TOOL_USE / PRE_LLM_CALL / USER_PROMPT_SUBMIT）：返回 HookDecision 改变主流程
  （proceed / block / modify / ask）。按 priority 升序执行，遇 block/ask 短路；modify 累积到 ctx。
- 观察类（POST_* / STOP / SUBAGENT_* / SESSION_* / *_COMPACT）：只做副作用，永远 proceed。

任一 handler 抛异常都被隔离（记日志，不拖垮主流程）。全局单例线程安全（多 Agent 并行）。
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class HookEvent(str, Enum):
    SESSION_START = "session_start"
    SESSION_END = "session_end"
    USER_PROMPT_SUBMIT = "user_prompt_submit"
    PRE_LLM_CALL = "pre_llm_call"
    POST_LLM_CALL = "post_llm_call"
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    STOP = "stop"
    SUBAGENT_START = "subagent_start"
    SUBAGENT_STOP = "subagent_stop"
    PRE_COMPACT = "pre_compact"
    POST_COMPACT = "post_compact"
    TASK_CREATED = "task_created"
    TASK_COMPLETED = "task_completed"


# 门控类事件：handler 返回值会改变主流程；其余为观察类。
GATING_EVENTS = frozenset(
    {
        HookEvent.PRE_TOOL_USE,
        HookEvent.PRE_LLM_CALL,
        HookEvent.USER_PROMPT_SUBMIT,
        HookEvent.TASK_CREATED,
        HookEvent.TASK_COMPLETED,
    }
)


@dataclass
class HookContext:
    """在 handler 之间流转、可被原地修改的上下文。"""

    event: HookEvent
    messages: list | None = None
    tool_name: str | None = None
    tool_args: dict | None = None
    tool_result: object | None = None
    role: str | None = None
    conversation: object | None = None
    tracer: object | None = None
    mode: str | None = None
    metadata: dict = field(default_factory=dict)
    feedback: list = field(default_factory=list)  # POST_TOOL_USE 可追加回灌给模型的消息


@dataclass
class HookDecision:
    action: str = "proceed"  # proceed | block | modify | ask
    reason: str = ""
    new_args: dict | None = None
    new_messages: list | None = None

    @classmethod
    def proceed(cls) -> "HookDecision":
        return cls("proceed")

    @classmethod
    def block(cls, reason: str = "") -> "HookDecision":
        return cls("block", reason=reason)

    @classmethod
    def modify(cls, *, new_args: dict | None = None, new_messages: list | None = None) -> "HookDecision":
        return cls("modify", new_args=new_args, new_messages=new_messages)

    @classmethod
    def ask(cls, reason: str = "") -> "HookDecision":
        return cls("ask", reason=reason)


@dataclass(order=True)
class _Entry:
    priority: int
    seq: int
    name: str = field(compare=False)
    handler: object = field(compare=False)


class HookManager:
    """事件 → 有序 handler 列表；fire() 按 priority 升序执行。"""

    def __init__(self) -> None:
        self._handlers: dict[HookEvent, list[_Entry]] = {}
        self._lock = threading.RLock()
        self._seq = 0

    def register(self, event, handler, *, priority: int = 100, name: str | None = None):
        """注册 handler。priority 越小越先执行（用于排定中间件顺序）。"""
        ev = HookEvent(event)
        with self._lock:
            self._seq += 1
            entry = _Entry(priority, self._seq, name or getattr(handler, "__name__", "hook"), handler)
            lst = self._handlers.setdefault(ev, [])
            lst.append(entry)
            lst.sort()
        return handler

    def on(self, event, *, priority: int = 100):
        """装饰器糖：@manager.on(HookEvent.STOP)"""

        def deco(fn):
            self.register(event, fn, priority=priority)
            return fn

        return deco

    def unregister(self, event, handler) -> None:
        ev = HookEvent(event)
        with self._lock:
            lst = self._handlers.get(ev)
            if lst:
                self._handlers[ev] = [e for e in lst if e.handler is not handler]

    def clear(self) -> None:
        with self._lock:
            self._handlers.clear()

    def handler_count(self, event=None) -> int:
        with self._lock:
            if event is None:
                return sum(len(v) for v in self._handlers.values())
            return len(self._handlers.get(HookEvent(event), []))

    def handler_names(self, event=None) -> set[str]:
        """Return the set of registered handler names, optionally filtered by event."""
        with self._lock:
            if event is None:
                return {e.name for lst in self._handlers.values() for e in lst}
            return {e.name for e in self._handlers.get(HookEvent(event), [])}

    def fire(self, ctx: HookContext) -> HookDecision:
        """触发事件。门控类返回最终决策（block/ask 短路，modify 累积）；观察类恒返回 proceed。"""
        with self._lock:
            entries = list(self._handlers.get(ctx.event, ()))
        if not entries:
            return HookDecision.proceed()

        gating = ctx.event in GATING_EVENTS
        result = HookDecision.proceed()
        for entry in entries:
            span = None
            if ctx.tracer is not None:
                try:
                    span = ctx.tracer.start_span(f"hook.{ctx.event.value}.{entry.name}", kind="hook")
                except Exception:  # noqa: BLE001 - 可观测失败不能影响 hook
                    span = None
            try:
                dec = entry.handler(ctx)
            except Exception as exc:  # noqa: BLE001 - 隔离 handler 异常，绝不拖垮主流程
                logger.warning("hook %s (%s) failed: %s", ctx.event.value, entry.name, exc)
                if span is not None:
                    try:
                        ctx.tracer.end_span(span, status="error")
                    except Exception:
                        pass
                continue
            if span is not None:
                try:
                    ctx.tracer.end_span(span)
                except Exception:
                    pass

            if not gating or dec is None:
                continue  # 观察类忽略返回值；门控类 None 视作 proceed
            if dec.action in ("block", "ask"):
                return dec  # 短路
            if dec.action == "modify":
                if dec.new_args is not None:
                    ctx.tool_args = dec.new_args
                if dec.new_messages is not None:
                    ctx.messages = dec.new_messages
                result = dec  # 累积；继续让后续 handler 在已修改的 ctx 上执行
        return result


# ---------------------------------------------------------------------------
# 全局单例
# ---------------------------------------------------------------------------

_manager: HookManager | None = None
_manager_lock = threading.Lock()


def get_hook_manager() -> HookManager:
    global _manager
    if _manager is None:
        with _manager_lock:
            if _manager is None:
                _manager = HookManager()
    return _manager


def reset_hook_manager() -> None:
    """测试用：重置全局管理器（清空所有注册）。"""
    global _manager
    with _manager_lock:
        _manager = None


def fire_event(event, **kwargs) -> HookDecision:
    """便捷触发全局总线上的事件。

    HOOKS_ENABLED 关、或该事件无注册 handler 时零开销旁路（返回 proceed）。
    供 run_tool_loop 之外的点（子 Agent / 多 Agent 生命周期等）轻量触发事件。
    """
    try:
        import config

        if not getattr(config, "HOOKS_ENABLED", True):
            return HookDecision.proceed()
    except Exception:  # noqa: BLE001
        pass
    mgr = get_hook_manager()
    if not mgr.handler_count(event):
        return HookDecision.proceed()
    return mgr.fire(HookContext(HookEvent(event), **kwargs))
