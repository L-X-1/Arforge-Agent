from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from arforge.bridge import dispatch
from arforge.product.action_runtime import ActionRuntime, ActionRuntimeError
from arforge.product.session_runtime import SessionRuntime
from arforge.product.state_store import BridgeStateStore


class NoopAgent:
    def __init__(self):
        self.conversation_history = []

    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, _value: str):
        return iter(())


def _live_runtime(tmp_path: Path):
    store = BridgeStateStore(tmp_path / "state" / "bridge_state.db")
    sessions = SessionRuntime(lambda _event: None, agent_factory=NoopAgent, store=store)
    actions = ActionRuntime(tmp_path, store=store)
    return store, sessions, actions


def test_restart_invalidates_session_approval_and_action_without_payload(tmp_path: Path):
    secret = "sk-" + "S" * 38
    store, sessions, actions = _live_runtime(tmp_path)
    session_id = sessions.create_session()["session_id"]
    tool = actions.prepare_tool(session_id, "calculate", {"expression": secret})
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    diff = actions.preview_diff(session_id, "note.txt", f"after {secret}")

    with sqlite3.connect(store.path) as connection:
        action_schema = " ".join(
            row[0] for row in connection.execute(
                "SELECT sql FROM sqlite_master WHERE name IN ('bridge_approvals', 'bridge_actions') AND sql IS NOT NULL"
            )
        )
        values = " ".join(
            str(value)
            for table in ("bridge_sessions", "bridge_approvals", "bridge_actions")
            for row in connection.execute(f"SELECT * FROM {table}")  # noqa: S608 - fixed table names
            for value in row
        )
    assert secret not in values
    assert "arguments" not in action_schema.lower()
    assert "content" not in action_schema.lower()
    assert "result" not in action_schema.lower()

    recovered_store = BridgeStateStore(store.path)
    recovered_sessions = SessionRuntime(
        lambda _event: None,
        agent_factory=NoopAgent,
        store=recovered_store,
    )
    recovered_actions = ActionRuntime(tmp_path, store=recovered_store)

    session = recovered_sessions.get_session(session_id)
    assert session["status"] == "interrupted"
    assert session["recovered"] is True
    assert session["context_available"] is False

    approval = recovered_actions.get_approval(session_id, tool["approval_id"])
    assert approval["status"] == "invalidated"
    assert approval["payload_available"] is False
    recovered_tool = recovered_actions.get_tool_action(session_id, tool["action_id"])
    assert recovered_tool["status"] == "invalidated"
    assert recovered_tool["arguments"] is None
    recovered_diff = recovered_actions.get_diff(session_id, diff["diff_id"])
    assert recovered_diff["status"] == "invalidated"
    assert recovered_diff["unified_diff"] is None

    with pytest.raises(ActionRuntimeError) as caught:
        recovered_actions.respond_approval(session_id, tool["approval_id"], "approve")
    assert caught.value.code == "PAYLOAD_UNAVAILABLE"


def test_applied_diff_recovers_as_unrecoverable_not_rollback_ready(tmp_path: Path):
    store, sessions, actions = _live_runtime(tmp_path)
    session_id = sessions.create_session()["session_id"]
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    preview = actions.preview_diff(session_id, "note.txt", "after")
    actions.respond_approval(session_id, preview["approval_id"], "approve")
    applied = actions.apply_diff(session_id, preview["diff_id"], preview["approval_id"])

    recovered_store = BridgeStateStore(store.path)
    recovered = ActionRuntime(tmp_path, store=recovered_store)
    metadata = recovered.get_diff(session_id, preview["diff_id"])

    assert metadata["status"] == "applied_unrecoverable"
    assert metadata["rollback_approval_id"] == applied["rollback_approval_id"]
    assert target.read_text(encoding="utf-8") == "after"
    with pytest.raises(ActionRuntimeError) as caught:
        recovered.rollback_diff(session_id, preview["diff_id"], applied["rollback_approval_id"])
    assert caught.value.code == "PAYLOAD_UNAVAILABLE"


def test_closed_session_remains_closed_and_is_discoverable(tmp_path: Path):
    store, sessions, _actions = _live_runtime(tmp_path)
    session_id = sessions.create_session()["session_id"]
    sessions.close_session(session_id)

    recovered = SessionRuntime(
        lambda _event: None,
        agent_factory=NoopAgent,
        store=BridgeStateStore(store.path),
    )
    listed = recovered.list_sessions()

    assert listed["total"] == 1
    assert listed["items"][0]["session_id"] == session_id
    assert listed["items"][0]["status"] == "closed"


def test_bridge_lists_recovered_session_and_action_metadata(tmp_path: Path):
    store, sessions, actions = _live_runtime(tmp_path)
    session_id = sessions.create_session()["session_id"]
    prepared = actions.prepare_tool(session_id, "calculate", {"expression": "2+2"})

    recovered_store = BridgeStateStore(store.path)
    recovered_sessions = SessionRuntime(
        lambda _event: None,
        agent_factory=NoopAgent,
        store=recovered_store,
    )
    recovered_actions = ActionRuntime(tmp_path, store=recovered_store)
    sessions_response = dispatch(
        {"version": "1.1", "method": "session.list", "params": {}},
        runtime=recovered_sessions,
        actions=recovered_actions,
    )
    actions_response = dispatch(
        {
            "version": "1.1",
            "method": "action.list",
            "params": {"session_id": session_id},
        },
        runtime=recovered_sessions,
        actions=recovered_actions,
    )

    assert sessions_response["data"]["items"][0]["status"] == "interrupted"
    item = actions_response["data"]["items"][0]
    assert item["record_id"] == prepared["action_id"]
    assert item["status"] == "invalidated"
    assert item["payload_available"] is False
    described = dispatch({"version": "1.1", "method": "protocol.describe"})
    assert "session.list" in described["data"]["methods"]
    assert "action.list" in described["data"]["methods"]


def test_project_conversation_history_can_resume_after_restart(tmp_path: Path):
    events: list[dict] = []
    store = BridgeStateStore(tmp_path / "state" / "bridge_state.db")
    project = store.ensure_project(tmp_path / "project")
    runtime = SessionRuntime(events.append, agent_factory=NoopAgent, store=store, project=project)
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "你好，继续这个项目", 10_000)
    runtime.release_operation(operation["operation_id"])
    for _ in range(100):
        if runtime.get_operation(operation["operation_id"])["status"] == "succeeded":
            break
        __import__("time").sleep(0.005)

    recovered_store = BridgeStateStore(store.path)
    recovered = SessionRuntime(
        lambda _event: None,
        agent_factory=NoopAgent,
        store=recovered_store,
        project=project,
    )
    listed = recovered.list_sessions(project_id=project["project_id"])
    assert listed["items"][0]["title"] == "你好，继续这个项目"
    assert listed["items"][0]["message_count"] == 2
    messages = recovered.get_messages(session["session_id"])
    assert [item["role"] for item in messages["items"]] == ["user", "assistant"]

    resumed = recovered.resume_session(session["session_id"])
    assert resumed["status"] == "active"
    assert resumed["context_available"] is True
    assert recovered._sessions[session["session_id"]].agent.conversation_history == [
        {"role": "user", "content": "你好，继续这个项目"},
        {"role": "assistant", "content": ""},
    ]
