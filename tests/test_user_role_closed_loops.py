"""End-to-end role journeys across the public Machine Bridge contract.

These tests intentionally compose operations that also have narrower unit
coverage.  A green result proves that the user-visible state machines can be
used in sequence, not merely that each endpoint works in isolation.
"""

from __future__ import annotations

import time

from arforge.bridge import dispatch
from arforge.product.action_runtime import ActionRuntime
from arforge.product.session_runtime import SessionRuntime
from arforge.product.state_store import BridgeStateStore
from arforge.tools import file_tools


class JourneyAgent:
    def __init__(self):
        self.conversation_history: list[dict] = []

    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, _value: str):
        yield {"type": "answer_delta", "data": {"content": "Request acknowledged."}}
        yield {"type": "done", "data": {}}


def _call(method: str, params: dict | None = None, **dependencies) -> dict:
    return dispatch(
        {"version": "1.2", "method": method, "params": params or {}},
        **dependencies,
    )


def _request(method: str, params: dict | None = None, **dependencies) -> dict:
    response = _call(method, params, **dependencies)
    assert response["ok"] is True, (method, response.get("error"))
    return response["data"]


def _wait(runtime: SessionRuntime, operation_id: str) -> str:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        status = runtime.get_operation(operation_id)["status"]
        if status in {"succeeded", "failed", "cancelled", "timed_out"}:
            return status
        time.sleep(0.01)
    raise AssertionError("chat operation did not settle")


def test_developer_journey_closes_chat_edit_verify_rollback_restart_and_export(tmp_path):
    previous_workspace = file_tools.WORKSPACE
    project_root = tmp_path / "project"
    project_root.mkdir()
    file_tools.set_workspace(project_root)
    target = project_root / "app.py"
    target.write_text("def total(a, b):\n    return a - b\n", encoding="utf-8")
    try:
        store = BridgeStateStore(tmp_path / "profile" / "state.db")
        project = store.ensure_project(project_root)
        events: list[dict] = []
        runtime = SessionRuntime(
            events.append,
            agent_factory=JourneyAgent,
            store=store,
            project=project,
        )
        actions = ActionRuntime(project_root, events.append, store=store)

        session = _request("session.create", runtime=runtime)
        session_id = session["session_id"]
        title = "修复合计逻辑"
        _request(
            "session.rename",
            {"session_id": session_id, "title": title},
            runtime=runtime,
        )
        tagged = _request(
            "session.tags.update",
            {"session_id": session_id, "tags": ["Bugfix", "Python"]},
            runtime=runtime,
        )
        operation = _request(
            "chat.start",
            {"session_id": session_id, "input": "hello"},
            runtime=runtime,
        )
        runtime.release_operation(operation["operation_id"])
        assert _wait(runtime, operation["operation_id"]) == "succeeded"
        checkpoint = _request(
            "session.checkpoint.create",
            {"session_id": session_id, "label": "before-change"},
            runtime=runtime,
        )

        preview = _request(
            "diff.preview",
            {
                "session_id": session_id,
                "file_path": "app.py",
                "new_content": "def total(a, b):\n    return a + b\n",
            },
            runtime=runtime,
            actions=actions,
        )
        denied = _call(
            "diff.apply",
            {
                "session_id": session_id,
                "diff_id": preview["diff_id"],
                "approval_id": preview["approval_id"],
            },
            runtime=runtime,
            actions=actions,
        )
        assert denied["error"]["code"] == "APPROVAL_REQUIRED"
        assert "return a - b" in target.read_text(encoding="utf-8")

        _request(
            "approval.respond",
            {
                "session_id": session_id,
                "approval_id": preview["approval_id"],
                "decision": "approve",
            },
            runtime=runtime,
            actions=actions,
        )
        applied = _request(
            "diff.apply",
            {
                "session_id": session_id,
                "diff_id": preview["diff_id"],
                "approval_id": preview["approval_id"],
            },
            runtime=runtime,
            actions=actions,
        )
        assert applied["status"] == "applied"

        tool = _request(
            "tool.prepare",
            {
                "session_id": session_id,
                "tool_name": "run_script",
                "arguments": {
                    "language": "python",
                    "code": (
                        "from pathlib import Path\n"
                        "assert 'return a + b' in Path('app.py').read_text()\n"
                        "print('verification-ok')"
                    ),
                },
            },
            runtime=runtime,
            actions=actions,
        )
        _request(
            "approval.respond",
            {
                "session_id": session_id,
                "approval_id": tool["approval_id"],
                "decision": "approve",
            },
            runtime=runtime,
            actions=actions,
        )
        verified = _request(
            "tool.execute",
            {
                "session_id": session_id,
                "action_id": tool["action_id"],
                "approval_id": tool["approval_id"],
            },
            runtime=runtime,
            actions=actions,
        )
        assert "verification-ok" in verified["result"]["output"]

        history = _request(
            "file.history",
            {"session_id": session_id, "file_path": "app.py"},
            runtime=runtime,
            actions=actions,
        )
        assert history["count"] == 1
        _request(
            "approval.respond",
            {
                "session_id": session_id,
                "approval_id": applied["rollback_approval_id"],
                "decision": "approve",
            },
            runtime=runtime,
            actions=actions,
        )
        rolled_back = _request(
            "diff.rollback",
            {
                "session_id": session_id,
                "diff_id": preview["diff_id"],
                "approval_id": applied["rollback_approval_id"],
            },
            runtime=runtime,
            actions=actions,
        )
        assert rolled_back["status"] == "rolled_back"
        assert "return a - b" in target.read_text(encoding="utf-8")

        exported = _request(
            "session.export",
            {"session_id": session_id, "format": "markdown"},
            runtime=runtime,
        )
        assert title in exported["content"]
        assert checkpoint["checkpoint_id"]
        assert tagged["tags"] == ["Bugfix", "Python"]

        # Opening the same profile simulates a sidecar restart: active work is
        # interrupted, explicitly resumed, and only then can it continue.
        recovered_store = BridgeStateStore(store.path)
        recovered = SessionRuntime(
            lambda _event: None,
            agent_factory=JourneyAgent,
            store=recovered_store,
            project=project,
        )
        assert _request("session.get", {"session_id": session_id}, runtime=recovered)["status"] == "interrupted"
        assert _request("session.resume", {"session_id": session_id}, runtime=recovered)["status"] == "active"
        messages = _request("session.messages", {"session_id": session_id}, runtime=recovered)
        assert messages["count"] == 2

        recovered_actions = ActionRuntime(project_root, store=recovered_store)
        assert _request(
            "session.close",
            {"session_id": session_id},
            runtime=recovered,
            actions=recovered_actions,
        )["status"] == "closed"
        closed_resume = _call(
            "session.resume",
            {"session_id": session_id},
            runtime=recovered,
        )
        assert closed_resume["error"]["code"] == "SESSION_CLOSED"
        assert any(event["type"] == "operation.completed" for event in events)
    finally:
        file_tools.set_workspace(previous_workspace)


def test_state_store_releases_windows_file_handles_after_each_operation(tmp_path):
    path = tmp_path / "profile" / "state.db"
    moved = path.with_name("state-moved.db")
    store = BridgeStateStore(path)
    project = store.ensure_project(tmp_path)
    store.save_session(
        {
            "session_id": "handle-check",
            "status": "active",
            "created_at": "2026-07-19T00:00:00Z",
            "updated_at": "2026-07-19T00:00:00Z",
            "project_id": project["project_id"],
            "parent_session_id": None,
            "title": "Handle check",
        }
    )

    # Windows refuses this rename while any SQLite connection still owns the
    # file.  Other platforms still gain a deterministic lifecycle assertion.
    path.replace(moved)

    assert moved.is_file()
    assert not path.exists()
