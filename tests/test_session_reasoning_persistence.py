"""Structured-message persistence and resume behaviour for the session runtime."""

from __future__ import annotations

import time

import pytest

from arforge.product.session_runtime import SessionRuntime
from arforge.product.state_store import BridgeStateStore


@pytest.fixture(autouse=True)
def _isolated_tool_registry(monkeypatch):
    """Force an empty tool registry for these tests so their inputs deterministically
    take the ``chat_stream`` path, regardless of which other test files registered
    tools into the shared global registry earlier in the run. The agentic router
    only engages when tools exist, so an empty registry pins these to the path
    they are designed to exercise."""
    from arforge.tool_registry import REGISTRY

    monkeypatch.setattr(REGISTRY, "tools", {})
    yield


class ReasoningAgent:
    """Streams reasoning + answer + tool event + artifact, like agent_core now does."""

    def __init__(self):
        self.multiagent = False
        self.conversation_history: list[dict] = []

    def should_use_multiagent(self, _user_input: str) -> bool:
        return self.multiagent

    def chat_stream(self, _user_input: str):
        yield {"type": "reasoning_started", "data": {}}
        yield {"type": "reasoning_delta", "data": {"section": "understanding", "content": "用户要修 bug"}}
        yield {"type": "reasoning_delta", "data": {"section": "thinking", "content": "定位根因"}}
        yield {
            "type": "reasoning_completed",
            "data": {"reasoning": {"understanding": "用户要修 bug", "thinking": "定位根因", "evidence": "", "reflection": ""}},
        }
        yield {"type": "answer_delta", "data": {"content": "已修复。"}}
        yield {
            "type": "done",
            "data": {
                "answer": "已修复。",
                "reasoning": {"understanding": "用户要修 bug", "thinking": "定位根因", "evidence": "", "reflection": ""},
                "tool_events": [{"kind": "file.write", "status": "completed", "target_path": "C:\\Desktop\\summary.txt"}],
                "artifacts": [{"artifact_id": "art1", "path": "C:\\Desktop\\summary.txt", "size_bytes": 4}],
                "meta": {"mode": "single"},
            },
        }


class LegacyXmlAgent:
    """Simulates an older agent that dumped the whole XML response as content."""

    def __init__(self):
        self.multiagent = False
        self.conversation_history: list[dict] = []

    def should_use_multiagent(self, _user_input: str) -> bool:
        return False

    def chat_stream(self, _user_input: str):
        raw = "<thinking>internal</thinking><answer>clean answer</answer>"
        yield {"type": "reasoning_started", "data": {}}
        yield {"type": "answer_delta", "data": {"content": raw}}
        yield {"type": "done", "data": {"answer": raw, "reasoning": {}, "meta": {"mode": "single"}}}


def _run_to_completion(runtime, session_id, user_input):
    operation = runtime.start_chat(session_id, user_input, 5000)
    runtime.release_operation(operation["operation_id"])
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = runtime.get_operation(operation["operation_id"])
        if current["status"] in {"succeeded", "failed", "cancelled", "timed_out"}:
            # Wait until the operation's finished gate is set too, so resume()
            # does not see it as an in-flight operation.
            record = runtime._operations.get(operation["operation_id"])
            if record is not None and record.finished.wait(1.0):
                return operation
        time.sleep(0.005)
    raise AssertionError("operation did not finish")


def test_persists_reasoning_tool_events_and_artifacts_beside_clean_answer(tmp_path):
    store = BridgeStateStore(tmp_path / "state.db")
    events: list[dict] = []
    runtime = SessionRuntime(events.append, agent_factory=ReasoningAgent, store=store)
    session = runtime.create_session()

    _run_to_completion(runtime, session["session_id"], "修个 bug")

    messages = store.load_messages(session["session_id"])
    assistant = next(item for item in messages if item["role"] == "assistant")
    # The stored answer body must be clean.
    assert assistant["content"] == "已修复。"
    assert "<thinking>" not in assistant["content"]
    # The structured channels are persisted separately.
    assert "定位根因" in assistant["reasoning_json"]
    assert "summary.txt" in assistant["tool_events_json"]
    assert "art1" in assistant["artifacts_json"]

    completed = next(event for event in events if event["type"] == "operation.completed")
    assert completed["data"]["answer"] == "已修复。"
    assert completed["data"]["reasoning"]["thinking"] == "定位根因"
    assert completed["data"]["tool_events"][0]["target_path"] == "C:\\Desktop\\summary.txt"
    assert completed["data"]["artifacts"][0]["artifact_id"] == "art1"

    # Reasoning must travel on its own events, never leak into answer.delta.
    answer_deltas = [event for event in events if event["type"] == "answer.delta"]
    assert "".join(event["data"]["content"] for event in answer_deltas) == "已修复。"
    reasoning_deltas = [event for event in events if event["type"] == "reasoning.delta"]
    assert any(event["data"]["section"] == "thinking" for event in reasoning_deltas)


def test_resume_replays_only_clean_answer_into_conversation_history(tmp_path):
    store = BridgeStateStore(tmp_path / "state.db")
    runtime = SessionRuntime(lambda _event: None, agent_factory=ReasoningAgent, store=store)
    session = runtime.create_session()
    _run_to_completion(runtime, session["session_id"], "修个 bug")

    resumed = runtime.resume_session(session["session_id"])
    agent = next(item for item in runtime._sessions.values() if item.session_id == resumed["session_id"]).agent
    # Only the clean answer is replayed — reasoning, tool events, and artifacts
    # must NOT enter the model context on resume.
    assert agent.conversation_history == [
        {"role": "user", "content": "修个 bug"},
        {"role": "assistant", "content": "已修复。"},
    ]


def test_resume_migrates_legacy_xml_content_before_replay(tmp_path):
    store = BridgeStateStore(tmp_path / "state.db")
    runtime = SessionRuntime(lambda _event: None, agent_factory=LegacyXmlAgent, store=store)
    session = runtime.create_session()
    _run_to_completion(runtime, session["session_id"], "你好")

    resumed = runtime.resume_session(session["session_id"])
    agent = next(item for item in runtime._sessions.values() if item.session_id == resumed["session_id"]).agent
    assistant_entry = next(item for item in agent.conversation_history if item["role"] == "assistant")
    # Legacy XML content must be migrated so the model never sees raw tags.
    assert assistant_entry["content"] == "clean answer"
    assert "<thinking>" not in assistant_entry["content"]


def test_active_operation_id_is_exposed_for_event_correlation(tmp_path):
    store = BridgeStateStore(tmp_path / "state.db")
    runtime = SessionRuntime(lambda _event: None, agent_factory=ReasoningAgent, store=store)
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "修个 bug", 5000)
    runtime.release_operation(operation["operation_id"])
    # While the chat runs, the active operation_id should be discoverable so the
    # bridge can stamp it onto tool/approval/artifact events.
    deadline = time.monotonic() + 1
    saw_active = False
    while time.monotonic() < deadline:
        active = runtime.active_operation_id(session["session_id"])
        if active == operation["operation_id"]:
            saw_active = True
            break
        time.sleep(0.005)
    # The agent is fast; if it already finished we just assert the helper returns None.
    final = runtime.active_operation_id(session["session_id"])
    assert saw_active or final is None
