"""HK-2 钩子接入 run_tool_loop 验收测试。

覆盖：事件在正确时点触发(PRE/POST_LLM_CALL、PRE/POST_TOOL_USE、STOP)；
PRE_TOOL_USE block 阻止真实执行并回灌失败；modify 改写参数；POST_TOOL_USE 回灌反馈；
HOOKS_ENABLED=False 时整条链旁路(总开关安全气囊)。
"""

import config
import pytest

from arforge.core.agentic import run_tool_loop
from arforge.core.hooks import (
    HookDecision,
    HookEvent,
    get_hook_manager,
    reset_hook_manager,
)
from arforge.tool_registry import ToolResult


class _TC:
    def __init__(self, id, name, arguments):
        self.id = id
        self.name = name
        self.arguments = arguments


class _Resp:
    def __init__(self, content="", tool_calls=None, usage=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage = usage or {}
        self.finish_reason = "stop"


class FakeAdapter:
    """step1 返回一个工具调用，step2 返回最终回答。"""

    model_name = "fake"

    def __init__(self):
        self.calls = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto"):
        self.calls += 1
        if self.calls == 1:
            return _Resp(tool_calls=[_TC("c1", "do_thing", '{"a": 1}')], usage={"prompt_tokens": 5, "completion_tokens": 2})
        return _Resp(content="done", usage={"prompt_tokens": 3, "completion_tokens": 1})


@pytest.fixture(autouse=True)
def _reset_hooks():
    reset_hook_manager()
    yield
    reset_hook_manager()


def _run(executor_calls, setup=None):
    if setup:
        setup(get_hook_manager())

    def executor(name, args):
        executor_calls.append((name, dict(args)))
        return ToolResult(name, True, "ok")

    adapter = FakeAdapter()
    return run_tool_loop(adapter, [{"role": "user", "content": "hi"}], tools=[], max_steps=5, executor=executor)


def test_events_fire_at_right_points():
    events = []

    def setup(mgr):
        for ev in (
            HookEvent.PRE_LLM_CALL,
            HookEvent.POST_LLM_CALL,
            HookEvent.PRE_TOOL_USE,
            HookEvent.POST_TOOL_USE,
            HookEvent.STOP,
        ):
            mgr.register(ev, (lambda e: (lambda ctx: events.append(e.value)))(ev))

    calls = []
    _run(calls, setup)
    assert events.count("pre_llm_call") == 2   # step1(工具) + step2(收尾)
    assert events.count("post_llm_call") == 2
    assert events.count("pre_tool_use") == 1
    assert events.count("post_tool_use") == 1
    assert events.count("stop") == 1
    assert calls == [("do_thing", {"a": 1})]


def test_pre_tool_use_block_prevents_execution():
    def setup(mgr):
        mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: HookDecision.block("denied"))

    calls = []
    result = _run(calls, setup)
    assert calls == []  # 工具真实执行被阻止
    assert any(c["tool"] == "do_thing" and not c["success"] for c in result.tool_calls)


def test_pre_tool_use_modify_changes_args():
    def setup(mgr):
        mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: HookDecision.modify(new_args={"a": 99}))

    calls = []
    _run(calls, setup)
    assert calls == [("do_thing", {"a": 99})]


def test_post_tool_use_feedback_appended():
    def setup(mgr):
        mgr.register(HookEvent.POST_TOOL_USE, lambda ctx: ctx.feedback.append({"role": "user", "content": "extra"}))

    calls = []
    result = _run(calls, setup)
    assert calls == [("do_thing", {"a": 1})]
    assert result.answer == "done"


def test_hooks_disabled_bypasses(monkeypatch):
    monkeypatch.setattr(config, "HOOKS_ENABLED", False)

    def setup(mgr):
        mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: HookDecision.block("denied"))

    calls = []
    _run(calls, setup)
    # 即便注册了 block 钩子，总开关关闭后整条链旁路 → 工具照常执行
    assert calls == [("do_thing", {"a": 1})]


def test_no_hooks_registered_is_noop():
    # 未注册任何 handler 时行为与无钩子一致：工具正常执行、得到最终答案
    calls = []
    result = _run(calls, setup=None)
    assert calls == [("do_thing", {"a": 1})]
    assert result.answer == "done"
    assert result.steps == 2
