"""v1-G6 任务级 resume 测试。"""

from __future__ import annotations

import pytest


# -- 对话 messages 落盘/加载 -------------------------------------------------


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))  # 隔离 runs 目录
    yield


def test_save_load_messages_roundtrip():
    from arforge.core.run_transaction import load_run_messages, save_run_messages

    msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]
    save_run_messages("r1", msgs)
    assert load_run_messages("r1") == msgs


def test_saved_messages_redact_source_and_tool_argument_credentials():
    from arforge.core.run_transaction import load_run_messages, save_run_messages

    secret = "db-pass-123"
    msgs = [
        {
            "role": "tool",
            "content": f"new PDO('mysql:host=127.0.0.1;dbname=app', 'root', '{secret}')",
        },
        {
            "role": "assistant",
            "tool_calls": [
                {"function": {"name": "run_cmd", "arguments": f'{{"password":"{secret}"}}'}}
            ],
        },
    ]

    save_run_messages("redacted", msgs)
    stored = load_run_messages("redacted")

    assert secret not in str(stored)
    assert "REDACTED" in str(stored)


def test_load_messages_missing_raises():
    from arforge.core.run_transaction import load_run_messages

    with pytest.raises(FileNotFoundError):
        load_run_messages("nope")


# -- LoopResult.messages 字段 ------------------------------------------------


def test_loopresult_has_messages_field():
    from arforge.core.agent_loop_v2 import LoopResult

    assert LoopResult(answer="x").messages == []


# -- run_agentic resume 分支（轻量 fake，不构造真 ArforgeAgent）--------------


class _FakeAgent:
    adapter = None

    def build_messages(self, user_input, use_reasoning=False):
        return [{"role": "system", "content": "base-system"}]


def _make_loop(monkeypatch, captured):
    from arforge.core.agent_loop_v2 import AgentLoopV2

    def fake_loop(adapter, messages, **kw):
        captured["messages"] = messages
        from arforge.core.agentic import ToolLoopResult

        return ToolLoopResult(answer="done", trace=[])

    monkeypatch.setattr("arforge.core.agentic.run_tool_loop", fake_loop)
    loop = AgentLoopV2.__new__(AgentLoopV2)  # 跳过 __init__，避免重构造
    loop.agent = _FakeAgent()
    return loop


def test_resume_refreshes_system_contract_and_preserves_history(monkeypatch):
    captured = {}
    loop = _make_loop(monkeypatch, captured)
    resume = [{"role": "system", "content": "s"}, {"role": "user", "content": "prev"}]
    result = loop.run_agentic("ignored", resume_messages=resume)
    assert captured["messages"] is not resume
    assert captured["messages"][0] == {"role": "system", "content": "base-system"}
    assert captured["messages"][1:] == resume[1:]
    assert result.messages is captured["messages"]


def test_no_resume_builds_messages(monkeypatch):
    captured = {}
    loop = _make_loop(monkeypatch, captured)
    result = loop.run_agentic("do task", resume_messages=None)
    assert captured["messages"][0]["content"].startswith("base-system")  # 走 build
    assert result.messages is captured["messages"]
