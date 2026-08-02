"""HK-3 子/多 Agent 生命周期事件 验收测试。

覆盖：SUBAGENT_START/STOP（成功+异常都发 STOP）、无 handler 无操作、SESSION_START/END。
"""

import pytest

from arforge.core.hooks import HookEvent, get_hook_manager, reset_hook_manager
from arforge.multiagent.protocol import Conversation, Task
from arforge.multiagent.sub_agent import SubAgent


@pytest.fixture(autouse=True)
def _reset():
    reset_hook_manager()
    yield
    reset_hook_manager()


class EchoAgent(SubAgent):
    role = "EchoAgent"

    def _run(self, task, conversation):
        return "ok", {}, [], []


class BoomAgent(SubAgent):
    role = "BoomAgent"

    def _run(self, task, conversation):
        raise RuntimeError("boom")


def test_subagent_start_stop_fired_on_success():
    events = []
    mgr = get_hook_manager()
    mgr.register(HookEvent.SUBAGENT_START, lambda ctx: events.append(("start", ctx.role)))
    mgr.register(HookEvent.SUBAGENT_STOP, lambda ctx: events.append(("stop", ctx.role, ctx.metadata.get("success"))))

    res = EchoAgent().execute(Task(task_id="t1", role="EchoAgent", goal="do"), Conversation(master_goal="g"))
    assert res.success
    assert ("start", "EchoAgent") in events
    assert ("stop", "EchoAgent", True) in events


def test_subagent_stop_fires_on_exception():
    seen = []
    get_hook_manager().register(HookEvent.SUBAGENT_STOP, lambda ctx: seen.append(ctx.metadata.get("success")))
    res = BoomAgent().execute(Task(task_id="t", role="BoomAgent", goal="x"), Conversation(master_goal="g"))
    assert not res.success
    assert seen == [False]  # 异常路径也发 STOP


def test_no_handler_is_noop():
    res = EchoAgent().execute(Task(task_id="t", role="EchoAgent", goal="x"), Conversation(master_goal="g"))
    assert res.success  # 未注册任何 handler → execute 行为不变


def test_session_events_fired(monkeypatch):
    events = []
    mgr = get_hook_manager()
    mgr.register(HookEvent.SESSION_START, lambda ctx: events.append("start"))
    mgr.register(HookEvent.SESSION_END, lambda ctx: events.append("stop"))

    from arforge.multiagent.master_agent import MasterAgent

    m = MasterAgent.__new__(MasterAgent)  # 绕过 __init__，仅测 handle 的事件
    monkeypatch.setattr(m, "_understand", lambda ui: type("U", (), {"needs_multiagent": False})())
    monkeypatch.setattr(m, "_needs_multiagent", lambda u: False)
    monkeypatch.setattr(m, "_single_agent_path", lambda ui: {"answer": "x", "mode": "single", "agents_used": 0})

    res = m.handle("do something")
    assert res["answer"] == "x"
    assert events == ["start", "stop"]
