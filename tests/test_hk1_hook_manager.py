"""HK-1 钩子内核 验收测试。

覆盖：注册/优先级排序、门控 block 短路、modify 累积并改写 ctx、观察类忽略返回值、
观察 handler 异常隔离、handler_count/unregister、全局单例 reset。
"""

from arforge.core.hooks import (
    HookContext,
    HookDecision,
    HookEvent,
    HookManager,
    get_hook_manager,
    reset_hook_manager,
)


def test_observer_runs_and_returns_proceed():
    mgr = HookManager()
    calls = []
    mgr.register(HookEvent.STOP, lambda ctx: calls.append(ctx.metadata.get("reason")))
    dec = mgr.fire(HookContext(HookEvent.STOP, metadata={"reason": "final"}))
    assert calls == ["final"]
    assert dec.action == "proceed"


def test_priority_order():
    mgr = HookManager()
    order = []
    mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: order.append("b"), priority=20)
    mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: order.append("a"), priority=10)
    mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: order.append("c"), priority=30)
    mgr.fire(HookContext(HookEvent.PRE_TOOL_USE, tool_name="x"))
    assert order == ["a", "b", "c"]


def test_block_short_circuits():
    mgr = HookManager()
    ran = []
    mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: HookDecision.block("nope"), priority=10)
    mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: ran.append("after"), priority=20)
    dec = mgr.fire(HookContext(HookEvent.PRE_TOOL_USE, tool_name="x"))
    assert dec.action == "block" and dec.reason == "nope"
    assert ran == []  # 第二个 handler 被短路，未执行


def test_modify_accumulates_and_updates_ctx():
    mgr = HookManager()
    mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: HookDecision.modify(new_args={"a": 2}), priority=10)
    seen = {}
    mgr.register(HookEvent.PRE_TOOL_USE, lambda ctx: seen.update(args=dict(ctx.tool_args)), priority=20)
    ctx = HookContext(HookEvent.PRE_TOOL_USE, tool_name="x", tool_args={"a": 1})
    dec = mgr.fire(ctx)
    assert ctx.tool_args == {"a": 2}        # ctx 被原地改写
    assert seen["args"] == {"a": 2}          # 后续 handler 看到已改写的参数
    assert dec.action == "modify"


def test_observer_exception_isolated():
    mgr = HookManager()
    ran = []

    def boom(ctx):
        raise RuntimeError("handler bug")

    mgr.register(HookEvent.POST_TOOL_USE, boom, priority=10)
    mgr.register(HookEvent.POST_TOOL_USE, lambda ctx: ran.append("ok"), priority=20)
    dec = mgr.fire(HookContext(HookEvent.POST_TOOL_USE, tool_name="x"))  # 不得抛出
    assert ran == ["ok"]
    assert dec.action == "proceed"


def test_observer_ignores_returned_decision():
    # 观察类事件(STOP)即便 handler 返回 block，也不得短路或改变流程
    mgr = HookManager()
    ran = []
    mgr.register(HookEvent.STOP, lambda ctx: HookDecision.block("x"), priority=10)
    mgr.register(HookEvent.STOP, lambda ctx: ran.append("ok"), priority=20)
    dec = mgr.fire(HookContext(HookEvent.STOP))
    assert ran == ["ok"]
    assert dec.action == "proceed"


def test_handler_count_and_unregister():
    mgr = HookManager()

    def h(ctx):
        return None

    mgr.register(HookEvent.STOP, h)
    assert mgr.handler_count(HookEvent.STOP) == 1
    assert mgr.handler_count() == 1
    mgr.unregister(HookEvent.STOP, h)
    assert mgr.handler_count(HookEvent.STOP) == 0


def test_fire_with_no_handlers_returns_proceed():
    mgr = HookManager()
    assert mgr.fire(HookContext(HookEvent.PRE_TOOL_USE, tool_name="x")).action == "proceed"


def test_global_singleton_reset():
    reset_hook_manager()
    m1 = get_hook_manager()
    m1.register(HookEvent.STOP, lambda ctx: None)
    assert get_hook_manager() is m1
    assert m1.handler_count() == 1
    reset_hook_manager()
    assert get_hook_manager() is not m1
    assert get_hook_manager().handler_count() == 0
    reset_hook_manager()
