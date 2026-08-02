from __future__ import annotations

from arforge.bridge import dispatch
from arforge.product.session_runtime import SessionRuntime


class CompactableAgent:
    def __init__(self):
        self.conversation_history = [
            {
                "role": "user" if index % 2 == 0 else "assistant",
                "content": f"turn-{index}",
            }
            for index in range(12)
        ]
        self._last_context_messages: list[dict] = []
        self._compaction_count = 0
        self._last_compaction: dict = {}
        self._context_checkpoint_active = False
        self.adapter = type("Adapter", (), {"model_name": "model[128k]"})()

    def context_status(self):
        return {
            "schema_version": 1,
            "model": "model[128k]",
            "context_window_tokens": 128_000,
            "used_tokens": len(self.conversation_history) * 10,
            "usage_percent": 1.0,
            "compaction_count": self._compaction_count,
            "last_compaction": dict(self._last_compaction),
        }


def test_manual_compaction_updates_live_context_through_bridge(monkeypatch):
    agent = CompactableAgent()
    runtime = SessionRuntime(lambda _event: None, agent_factory=lambda: agent)
    session = runtime.create_session()
    observed: dict[str, object] = {}

    def fake_compact(messages, adapter, model, **kwargs):
        observed.update(
            messages=list(messages),
            adapter=adapter,
            model=model,
            kwargs=kwargs,
        )
        return (
            [
                messages[0],
                {"role": "assistant", "content": "protected summary"},
                *messages[-2:],
            ],
            {
                "compacted": True,
                "before_tokens": 120,
                "after_tokens": 40,
                "protected_facts_preserved": 3,
            },
        )

    monkeypatch.setattr("arforge.core.compaction.compact", fake_compact)

    response = dispatch(
        {
            "id": 1,
            "version": "1.2",
            "method": "session.compact",
            "params": {
                "session_id": session["session_id"],
                "focus": "preserve acceptance evidence",
            },
        },
        runtime=runtime,
    )

    assert response["ok"] is True
    assert response["data"]["compacted"] is True
    assert response["data"]["stats"]["before_tokens"] == 120
    assert response["data"]["stats"]["after_tokens"] == 40
    assert response["data"]["session"]["context_status"]["compaction_count"] == 1
    assert agent.conversation_history[1]["content"] == "protected summary"
    assert agent._context_checkpoint_active is True
    assert observed["model"] == "model[128k]"
    assert observed["kwargs"] == {
        "keep_recent": 6,
        "persist_durable": True,
        "custom_focus": "preserve acceptance evidence",
    }


def test_manual_compaction_is_advertised_mutating_and_strict():
    described = dispatch({"id": 1, "version": "1.2", "method": "protocol.describe"})
    runtime = SessionRuntime(lambda _event: None, agent_factory=CompactableAgent)
    session = runtime.create_session()
    rejected = dispatch(
        {
            "id": 2,
            "version": "1.2",
            "method": "session.compact",
            "params": {"session_id": session["session_id"], "focus": "", "extra": True},
        },
        runtime=runtime,
    )

    assert "session.compact" in described["data"]["methods"]
    assert "session.compact" in described["data"]["mutating_methods"]
    assert "session.compact" not in described["data"]["workspace_mutating_methods"]
    assert rejected["error"]["code"] == "INVALID_PARAMS"
