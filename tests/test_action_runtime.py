from __future__ import annotations

import time
from pathlib import Path

import pytest

from arforge.bridge import dispatch
from arforge.product.action_runtime import ActionRuntime, ActionRuntimeError
from arforge.product.session_runtime import SessionRuntime
from arforge.product.state_store import BridgeStateStore


class NoopAgent:
    pass


def _approve(actions: ActionRuntime, session_id: str, approval_id: str) -> dict:
    return actions.respond_approval(session_id, approval_id, "approve")


def test_preview_is_read_only_and_creates_pending_approval(tmp_path: Path):
    target = tmp_path / "app.py"
    target.write_text("value = 1\n", encoding="utf-8")
    events: list[dict] = []
    actions = ActionRuntime(tmp_path, events.append)

    preview = actions.preview_diff("session-1", "app.py", "value = 2\n")

    assert target.read_text(encoding="utf-8") == "value = 1\n"
    assert preview["status"] == "previewed"
    assert preview["approval"]["status"] == "pending"
    assert preview["approval"]["action_type"] == "diff.apply"
    assert preview["stats"] == {"additions": 1, "deletions": 1, "hunks": 1}
    assert "-value = 1" in preview["unified_diff"]
    assert "+value = 2" in preview["unified_diff"]
    assert [event["type"] for event in events] == ["approval.requested", "diff.previewed"]


def test_apply_requires_matching_single_use_approval(tmp_path: Path):
    target = tmp_path / "app.py"
    target.write_text("value = 1\n", encoding="utf-8")
    actions = ActionRuntime(tmp_path)
    preview = actions.preview_diff("session-1", "app.py", "value = 2\n")

    with pytest.raises(ActionRuntimeError, match="approval status is pending"):
        actions.apply_diff("session-1", preview["diff_id"], preview["approval_id"])
    _approve(actions, "session-1", preview["approval_id"])
    applied = actions.apply_diff("session-1", preview["diff_id"], preview["approval_id"])

    assert applied["status"] == "applied"
    assert target.read_text(encoding="utf-8") == "value = 2\n"
    assert applied["rollback_approval"]["status"] == "pending"
    with pytest.raises(ActionRuntimeError, match="cannot apply"):
        actions.apply_diff("session-1", preview["diff_id"], preview["approval_id"])


def test_reject_never_writes_and_is_idempotent(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    actions = ActionRuntime(tmp_path)
    preview = actions.preview_diff("session-1", "note.txt", "after")

    rejected = actions.reject_diff("session-1", preview["diff_id"])
    repeated = actions.reject_diff("session-1", preview["diff_id"])

    assert rejected["status"] == repeated["status"] == "rejected"
    assert rejected["approval"]["status"] == "rejected"
    assert target.read_text(encoding="utf-8") == "before"


def test_apply_detects_file_change_after_preview(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    actions = ActionRuntime(tmp_path)
    preview = actions.preview_diff("session-1", "note.txt", "approved content")
    _approve(actions, "session-1", preview["approval_id"])
    target.write_text("external change", encoding="utf-8")

    with pytest.raises(ActionRuntimeError, match="file changed after preview") as caught:
        actions.apply_diff("session-1", preview["diff_id"], preview["approval_id"])

    assert caught.value.code == "DIFF_CONFLICT"
    assert target.read_text(encoding="utf-8") == "external change"
    assert actions.get_diff("session-1", preview["diff_id"])["status"] == "conflicted"


def test_invalid_python_is_rejected_before_write(tmp_path: Path):
    target = tmp_path / "app.py"
    target.write_text("value = 1\n", encoding="utf-8")
    actions = ActionRuntime(tmp_path)
    preview = actions.preview_diff("session-1", "app.py", "def broken(:\n")
    _approve(actions, "session-1", preview["approval_id"])

    with pytest.raises(ActionRuntimeError) as caught:
        actions.apply_diff("session-1", preview["diff_id"], preview["approval_id"])

    assert caught.value.code == "VALIDATION_FAILED"
    assert target.read_text(encoding="utf-8") == "value = 1\n"


def test_rollback_requires_separate_approval_and_restores_original(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    actions = ActionRuntime(tmp_path)
    preview = actions.preview_diff("session-1", "note.txt", "after")
    _approve(actions, "session-1", preview["approval_id"])
    applied = actions.apply_diff("session-1", preview["diff_id"], preview["approval_id"])
    rollback_id = applied["rollback_approval_id"]

    with pytest.raises(ActionRuntimeError, match="approval status is pending"):
        actions.rollback_diff("session-1", preview["diff_id"], rollback_id)
    _approve(actions, "session-1", rollback_id)
    rolled_back = actions.rollback_diff("session-1", preview["diff_id"], rollback_id)

    assert rolled_back["status"] == "rolled_back"
    assert target.read_text(encoding="utf-8") == "before"


def test_rollback_conflict_issues_a_fresh_one_time_approval(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    actions = ActionRuntime(tmp_path)
    preview = actions.preview_diff("session-1", "note.txt", "after")
    _approve(actions, "session-1", preview["approval_id"])
    applied = actions.apply_diff("session-1", preview["diff_id"], preview["approval_id"])
    first_rollback_id = applied["rollback_approval_id"]
    _approve(actions, "session-1", first_rollback_id)
    target.write_text("external change", encoding="utf-8")

    with pytest.raises(ActionRuntimeError, match="file changed after apply") as caught:
        actions.rollback_diff("session-1", preview["diff_id"], first_rollback_id)

    refreshed = actions.get_diff("session-1", preview["diff_id"])
    assert caught.value.code == "DIFF_CONFLICT"
    assert target.read_text(encoding="utf-8") == "external change"
    assert refreshed["status"] == "applied"
    assert refreshed["rollback_approval_id"] != first_rollback_id
    assert actions.get_approval("session-1", first_rollback_id)["status"] == "consumed"
    assert actions.get_approval("session-1", refreshed["rollback_approval_id"])["status"] == "pending"


def test_new_file_rollback_removes_only_unchanged_applied_file(tmp_path: Path):
    target = tmp_path / "new.txt"
    actions = ActionRuntime(tmp_path)
    preview = actions.preview_diff("session-1", "new.txt", "created\n")
    _approve(actions, "session-1", preview["approval_id"])
    applied = actions.apply_diff("session-1", preview["diff_id"], preview["approval_id"])
    assert target.exists()
    _approve(actions, "session-1", applied["rollback_approval_id"])

    actions.rollback_diff("session-1", preview["diff_id"], applied["rollback_approval_id"])
    assert not target.exists()


@pytest.mark.parametrize(
    "path,code",
    [
        ("../escape.txt", "PATH_OUTSIDE_WORKSPACE"),
        (".git/config", "PROTECTED_PATH"),
        (".venv/secret.txt", "PROTECTED_PATH"),
    ],
)
def test_preview_rejects_workspace_escape_and_protected_paths(tmp_path: Path, path: str, code: str):
    actions = ActionRuntime(tmp_path)
    with pytest.raises(ActionRuntimeError) as caught:
        actions.preview_diff("session-1", path, "content")
    assert caught.value.code == code


def test_session_isolation_prevents_cross_session_approval(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    actions = ActionRuntime(tmp_path)
    preview = actions.preview_diff("session-1", "note.txt", "after")

    with pytest.raises(ActionRuntimeError) as caught:
        actions.respond_approval("session-2", preview["approval_id"], "approve")

    assert caught.value.code == "SESSION_MISMATCH"
    assert target.read_text(encoding="utf-8") == "before"


def test_approved_request_expires_before_use(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    actions = ActionRuntime(tmp_path)
    preview = actions.preview_diff("session-1", "note.txt", "after", ttl_seconds=1)
    _approve(actions, "session-1", preview["approval_id"])
    time.sleep(1.05)

    with pytest.raises(ActionRuntimeError) as caught:
        actions.apply_diff("session-1", preview["diff_id"], preview["approval_id"])

    assert caught.value.code == "APPROVAL_REQUIRED"
    assert target.read_text(encoding="utf-8") == "before"


def test_bridge_action_flow_uses_live_session_and_stable_contract(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    runtime = SessionRuntime(lambda _event: None, agent_factory=NoopAgent)
    actions = ActionRuntime(tmp_path)
    session = runtime.create_session()
    session_id = session["session_id"]

    preview_response = dispatch(
        {
            "id": 1,
            "version": "1.1",
            "method": "diff.preview",
            "params": {"session_id": session_id, "file_path": "note.txt", "new_content": "after"},
        },
        runtime=runtime,
        actions=actions,
    )
    preview = preview_response["data"]
    approved = dispatch(
        {
            "id": 2,
            "version": "1.1",
            "method": "approval.respond",
            "params": {"session_id": session_id, "approval_id": preview["approval_id"], "decision": "approve"},
        },
        runtime=runtime,
        actions=actions,
    )
    applied = dispatch(
        {
            "id": 3,
            "version": "1.1",
            "method": "diff.apply",
            "params": {"session_id": session_id, "diff_id": preview["diff_id"], "approval_id": preview["approval_id"]},
        },
        runtime=runtime,
        actions=actions,
    )

    assert preview_response["ok"] is True
    assert approved["data"]["status"] == "approved"
    assert applied["data"]["status"] == "applied"
    assert target.read_text(encoding="utf-8") == "after"


def test_bridge_advertises_explicit_workspace_mutations():
    response = dispatch({"version": "1.1", "method": "protocol.describe", "params": {}})
    assert response["data"]["workspace_mutating_methods"] == [
        "diff.apply",
        "diff.rollback",
        "git.checkout",
        "git.worktree.create",
        "git.worktree.remove",
        "run.revert",
        "tool.execute",
        "tool.execute_async",
        "workflow.graph.approve",
        "workflow.graph.resume",
        "workflow.graph.retry",
        "workflow.graph.start",
    ]
    assert "approval.respond" in response["data"]["stateful_methods"]


def test_file_history_is_session_scoped_and_metadata_only(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before\n", encoding="utf-8")
    actions = ActionRuntime(tmp_path)
    first = actions.preview_diff("session-1", "note.txt", "first\n")
    second = actions.preview_diff("session-1", "note.txt", "second\n")
    actions.preview_diff("session-2", "note.txt", "other\n")

    history = actions.list_file_history("session-1", "note.txt")

    assert history["file_path"] == "note.txt"
    assert history["count"] == history["total"] == 2
    assert {item["revision_id"] for item in history["items"]} == {first["diff_id"], second["diff_id"]}
    assert all(item["payload_available"] is True for item in history["items"])
    assert all("unified_diff" not in item for item in history["items"])
    with pytest.raises(ActionRuntimeError, match="path escapes the workspace"):
        actions.list_file_history("session-1", "../outside.txt")


def test_file_history_survives_restart_without_source_payload(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before\n", encoding="utf-8")
    store = BridgeStateStore(tmp_path / "state" / "bridge_state.db")
    actions = ActionRuntime(tmp_path, store=store)
    preview = actions.preview_diff("session-1", "note.txt", "after\n")

    recovered = ActionRuntime(tmp_path, store=BridgeStateStore(store.path))
    history = recovered.list_file_history("session-1", "note.txt")

    assert history["count"] == 1
    item = history["items"][0]
    assert item["revision_id"] == preview["diff_id"]
    assert item["recovered"] is True
    assert item["payload_available"] is False
    assert item["stats"] is None


def test_bridge_file_history_allows_closed_session_metadata(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before\n", encoding="utf-8")
    runtime = SessionRuntime(lambda _event: None, agent_factory=NoopAgent)
    actions = ActionRuntime(tmp_path)
    session_id = runtime.create_session()["session_id"]
    preview = actions.preview_diff(session_id, "note.txt", "after\n")
    actions.reject_diff(session_id, preview["diff_id"])
    runtime.close_session(session_id)

    response = dispatch(
        {
            "version": "1.2",
            "method": "file.history",
            "params": {"session_id": session_id, "file_path": "note.txt"},
        },
        runtime=runtime,
        actions=actions,
    )

    assert response["ok"] is True
    assert response["data"]["items"][0]["revision_id"] == preview["diff_id"]


def test_bridge_refuses_session_close_until_preview_is_resolved(tmp_path: Path):
    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    runtime = SessionRuntime(lambda _event: None, agent_factory=NoopAgent)
    actions = ActionRuntime(tmp_path)
    session_id = runtime.create_session()["session_id"]
    preview = actions.preview_diff(session_id, "note.txt", "after")

    blocked = dispatch(
        {
            "version": "1.1",
            "method": "session.close",
            "params": {"session_id": session_id},
        },
        runtime=runtime,
        actions=actions,
    )
    assert blocked["error"]["code"] == "SESSION_BUSY"

    actions.reject_diff(session_id, preview["diff_id"])
    closed = dispatch(
        {
            "version": "1.1",
            "method": "session.close",
            "params": {"session_id": session_id},
        },
        runtime=runtime,
        actions=actions,
    )
    assert closed["data"]["status"] == "closed"


def test_tool_execution_requires_approval_and_returns_structured_result(tmp_path: Path):
    actions = ActionRuntime(tmp_path)
    prepared = actions.prepare_tool("session-1", "calculate", {"expression": "2+3*4"})

    assert prepared["status"] == "prepared"
    assert prepared["approval"]["status"] == "pending"
    with pytest.raises(ActionRuntimeError) as caught:
        actions.execute_tool("session-1", prepared["action_id"], prepared["approval_id"])
    assert caught.value.code == "APPROVAL_REQUIRED"

    _approve(actions, "session-1", prepared["approval_id"])
    executed = actions.execute_tool("session-1", prepared["action_id"], prepared["approval_id"])
    assert executed["status"] == "succeeded"
    assert executed["result"]["success"] is True
    assert executed["result"]["output"] == "14"
    with pytest.raises(ActionRuntimeError) as replay:
        actions.execute_tool("session-1", prepared["action_id"], prepared["approval_id"])
    assert replay.value.code == "INVALID_STATE"


def test_rejected_tool_never_executes(tmp_path: Path):
    actions = ActionRuntime(tmp_path)
    prepared = actions.prepare_tool("session-1", "calculate", {"expression": "40+2"})
    actions.respond_approval("session-1", prepared["approval_id"], "reject")
    rejected = actions.reject_tool("session-1", prepared["action_id"])

    assert rejected["status"] == "rejected"
    assert rejected["result"] is None
    with pytest.raises(ActionRuntimeError):
        actions.execute_tool("session-1", prepared["action_id"], prepared["approval_id"])


@pytest.mark.parametrize(
    "tool_name,arguments",
    [
        ("missing-tool", {}),
        ("calculate", {}),
        ("calculate", {"expression": "1+1", "extra": True}),
        ("calculate", {"expression": 123}),
    ],
)
def test_tool_prepare_validates_registry_schema(tmp_path: Path, tool_name: str, arguments: dict):
    actions = ActionRuntime(tmp_path)
    with pytest.raises(ActionRuntimeError):
        actions.prepare_tool("session-1", tool_name, arguments)


def test_bridge_tool_flow_requires_live_session(tmp_path: Path):
    runtime = SessionRuntime(lambda _event: None, agent_factory=NoopAgent)
    actions = ActionRuntime(tmp_path)
    session_id = runtime.create_session()["session_id"]
    prepared_response = dispatch(
        {
            "version": "1.1",
            "method": "tool.prepare",
            "params": {
                "session_id": session_id,
                "tool_name": "calculate",
                "arguments": {"expression": "6*7"},
            },
        },
        runtime=runtime,
        actions=actions,
    )
    prepared = prepared_response["data"]
    dispatch(
        {
            "version": "1.1",
            "method": "approval.respond",
            "params": {
                "session_id": session_id,
                "approval_id": prepared["approval_id"],
                "decision": "approve",
            },
        },
        runtime=runtime,
        actions=actions,
    )
    executed = dispatch(
        {
            "version": "1.1",
            "method": "tool.execute",
            "params": {
                "session_id": session_id,
                "action_id": prepared["action_id"],
                "approval_id": prepared["approval_id"],
            },
        },
        runtime=runtime,
        actions=actions,
    )

    assert executed["ok"] is True
    assert executed["data"]["result"]["output"] == "42"
