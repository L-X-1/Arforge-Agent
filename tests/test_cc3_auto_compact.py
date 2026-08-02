"""CC-3 自动压缩触发 验收测试。

覆盖：needs_compaction 阈值、auto_compact_hook（强制/不需/禁用）、run_tool_loop honor
PRE_LLM_CALL modify（auto_compact 在循环中生效的机制）。
"""

import config
import pytest

from arforge.core import compaction
from arforge.core.agentic import run_tool_loop
from arforge.core.compaction import (
    auto_compact_hook,
    compaction_scope,
    install_compaction_hook,
    needs_compaction,
    request_force_compact,
)
from arforge.core.hooks import HookContext, HookDecision, HookEvent, get_hook_manager, reset_hook_manager


@pytest.fixture(autouse=True)
def _reset():
    reset_hook_manager()
    with compaction_scope():
        yield
    reset_hook_manager()


class _Resp:
    def __init__(self, content="", tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage = {}
        self.finish_reason = "stop"


class SummarizerAdapter:
    model_name = "deepseek-v4-flash"

    def generate(self, messages, max_tokens=None, temperature=None, response_format=None):
        return "SUMMARY"


def test_needs_compaction_threshold(monkeypatch):
    monkeypatch.setitem(config.MODEL_CONTEXT_WINDOW, "deepseek-v4-flash", 8_000)
    big = [{"role": "user", "content": "你" * 6_000}]
    assert needs_compaction(big, "deepseek-v4-flash") is True


def test_small_custom_window_does_not_compact_every_nonempty_turn(monkeypatch):
    monkeypatch.setattr(config, "CHAT_MAX_TOKENS", 16_384)

    assert needs_compaction(
        [{"role": "user", "content": "A normal short request"}],
        "compatible[8k]",
        8_000,
    ) is False


def test_needs_compaction_false_for_small():
    assert needs_compaction([{"role": "user", "content": "hi"}], "deepseek-v4-flash") is False


def _long_history():
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "task"}]
    msgs += [{"role": "assistant", "content": f"step {i}"} for i in range(12)]
    return msgs


def test_auto_compact_hook_modifies_when_forced():
    install_compaction_hook()
    request_force_compact()
    ctx = HookContext(HookEvent.PRE_LLM_CALL, messages=_long_history(), metadata={"adapter": SummarizerAdapter()})
    dec = auto_compact_hook(ctx)
    assert dec is not None and dec.action == "modify"
    assert any(str(m.get("content", "")).startswith("【历史摘要】") for m in dec.new_messages)
    assert len(dec.new_messages) < len(_long_history())


def test_auto_compact_hook_noop_when_not_needed():
    ctx = HookContext(HookEvent.PRE_LLM_CALL, messages=[{"role": "user", "content": "hi"}], metadata={"adapter": SummarizerAdapter()})
    assert auto_compact_hook(ctx) is None


def test_auto_compact_disabled(monkeypatch):
    monkeypatch.setattr(config, "AUTO_COMPACT_ENABLED", False)
    monkeypatch.setattr(compaction, "needs_compaction", lambda m, model: True)
    ctx = HookContext(HookEvent.PRE_LLM_CALL, messages=_long_history(), metadata={"adapter": SummarizerAdapter()})
    assert auto_compact_hook(ctx) is None  # 总开关关 → 不压


def test_loop_honors_pre_llm_call_modify():
    """run_tool_loop 必须采用 PRE_LLM_CALL handler 的 modify(new_messages) —— 这是 auto_compact
    在循环中生效的机制。"""
    seen = {}

    class CapAdapter:
        model_name = "x"

        def generate_with_tools(self, messages, tools=None, tool_choice="auto"):
            seen["last"] = [m.get("content") for m in messages]
            return _Resp(content="done")

    get_hook_manager().register(
        HookEvent.PRE_LLM_CALL,
        lambda ctx: HookDecision.modify(new_messages=[{"role": "user", "content": "REPLACED"}]),
    )
    result = run_tool_loop(CapAdapter(), [{"role": "user", "content": "orig"}], tools=[], max_steps=2)
    assert result.answer == "done"
    assert seen["last"] == ["REPLACED"]
    assert result.messages == [
        {"role": "user", "content": "REPLACED"},
        {"role": "assistant", "content": "done"},
    ]
