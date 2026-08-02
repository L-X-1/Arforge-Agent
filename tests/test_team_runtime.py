from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import arforge.tools.basic_tools  # noqa: F401
import arforge.tools.team_tools  # noqa: F401
from arforge.bridge import dispatch
from arforge.multiagent.protocol import AgentRole
from arforge.multiagent.security import role_scope
from arforge.multiagent.sub_agent import SubAgent
from arforge.product.action_runtime import ActionRuntime
from arforge.product.session_runtime import SessionRuntime
from arforge.team_runtime import MAX_MEMBERS, TeamManager, TeamRuntimeError
from arforge.tool_registry import REGISTRY
from arforge.workspace_context import execution_scope


class NoopAgent:
    conversation_history: list[dict] = []


def _manager(tmp_path: Path) -> TeamManager:
    return TeamManager(tmp_path / "profile" / "teams.json")


def test_one_team_per_session_and_durable_restart(tmp_path: Path):
    manager = _manager(tmp_path)
    created = manager.create("session-a", "Release Team", "prepare release")
    manager.add_member("session-a", "reviewer", "ReviewerAgent")

    with pytest.raises(TeamRuntimeError, match="already owns"):
        manager.create("session-a", "Other Team")

    restored = TeamManager(manager.state_path).get("session-a")
    assert restored["team_id"] == created["team_id"]
    assert restored["description"] == "prepare release"
    assert [item["name"] for item in restored["members"]] == ["lead", "reviewer"]


def test_member_and_role_bounds_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    manager = _manager(tmp_path)
    manager.create("session-a", "Team")
    manager.add_member("session-a", "coder", "CoderAgent")

    with pytest.raises(TeamRuntimeError, match="already exists"):
        manager.add_member("session-a", "CODER", "TesterAgent")
    with pytest.raises(TeamRuntimeError, match="already assigned"):
        manager.add_member("session-a", "coder2", "CoderAgent")
    with pytest.raises(TeamRuntimeError, match="unknown subagent role"):
        manager.add_member("session-a", "unknown", "MissingAgent")

    roles = [
        "PlannerAgent",
        "ReviewerAgent",
        "TesterAgent",
        "SearcherAgent",
        "DocAgent",
        "DebuggerAgent",
        "DataAgent",
    ]
    for index, role in enumerate(roles, start=1):
        manager.add_member("session-a", f"member{index}", role)
    assert manager.get("session-a")["member_count"] == MAX_MEMBERS

    from arforge.multiagent.sub_agent_pool import get_sub_agent_pool

    pool = get_sub_agent_pool()
    original = pool.is_registered
    monkeypatch.setattr(
        pool,
        "is_registered",
        lambda role: role == "NinthAgent" or original(role),
    )
    with pytest.raises(TeamRuntimeError, match="at most"):
        manager.add_member("session-a", "overflow", "NinthAgent")


def test_direct_and_broadcast_mailboxes_are_team_scoped(tmp_path: Path):
    manager = _manager(tmp_path)
    manager.create("session-a", "Alpha")
    manager.add_member("session-a", "coder", "CoderAgent")
    manager.add_member("session-a", "tester", "TesterAgent")
    manager.create("session-b", "Beta")
    manager.add_member("session-b", "other", "ReviewerAgent")

    direct = manager.send_message("session-a", "coder", "implement feature")
    broadcast = manager.send_message("session-a", "*", "status check", kind="request")

    coder = manager.list_messages("session-a", actor="coder")
    tester = manager.list_messages("session-a", actor="tester")
    other = manager.list_messages("session-b", actor="other")

    assert direct["recipients"] == ["coder"]
    assert broadcast["recipients"] == ["coder", "tester"]
    assert [item["message"] for item in coder["messages"]] == [
        "implement feature",
        "status check",
    ]
    assert [item["message"] for item in tester["messages"]] == ["status check"]
    assert other["messages"] == []
    with pytest.raises(TeamRuntimeError, match="not found"):
        manager.send_message("session-b", "coder", "cross-team attempt")


def test_graceful_shutdown_is_required_before_remove_and_delete(tmp_path: Path):
    manager = _manager(tmp_path)
    manager.create("session-a", "Team")
    manager.add_member("session-a", "coder", "CoderAgent")

    with pytest.raises(TeamRuntimeError, match="shutdown approval"):
        manager.remove_member("session-a", "coder")
    with pytest.raises(TeamRuntimeError, match="active members"):
        manager.delete("session-a")

    request = manager.request_shutdown("session-a", "coder", "work complete")
    with pytest.raises(TeamRuntimeError, match="only answer its own"):
        manager.respond_shutdown(
            "session-a",
            request["request_id"],
            True,
            actor="lead",
        )
    rejected = manager.respond_shutdown(
        "session-a",
        request["request_id"],
        False,
        "tests still running",
        actor="coder",
    )
    assert rejected["status"] == "rejected"
    assert manager.get("session-a")["members"][1]["status"] == "active"

    second = manager.request_shutdown("session-a", "coder")
    approved = manager.respond_shutdown(
        "session-a",
        second["request_id"],
        True,
        actor="coder",
    )
    assert approved["status"] == "approved"
    manager.remove_member("session-a", "coder")
    deleted = manager.delete("session-a")

    assert deleted["deleted"] is True
    assert json.loads(manager.state_path.read_text(encoding="utf-8"))["teams"] == {}


def test_concurrent_mailbox_writes_keep_unique_monotonic_sequences(tmp_path: Path):
    first = _manager(tmp_path)
    second = TeamManager(first.state_path)
    first.create("session-a", "Team")
    first.add_member("session-a", "coder", "CoderAgent")

    def send(index: int):
        manager = first if index % 2 else second
        return manager.send_message("session-a", "coder", f"message-{index}")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(send, range(40)))

    sequences = sorted(item["sequence"] for item in results)
    inbox = TeamManager(first.state_path).list_messages(
        "session-a",
        actor="coder",
        limit=100,
    )
    assert sequences == list(range(1, 41))
    assert len({item["message_id"] for item in results}) == 40
    assert inbox["count"] == 40


def test_registered_subagent_role_resolves_to_its_member_mailbox(tmp_path: Path):
    manager = _manager(tmp_path)
    manager.create("session-a", "Team")
    manager.add_member("session-a", "coder", "CoderAgent")
    assert manager.resolve_actor("session-a", "CoderAgent") == "coder"
    with pytest.raises(TeamRuntimeError, match="not registered"):
        manager.resolve_actor("session-a", "ReviewerAgent")


def test_agent_tools_use_lead_and_subagent_identity(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    from arforge.team_runtime import get_team_manager

    manager = get_team_manager()
    manager.create("session-a", "Team")
    manager.add_member("session-a", "coder", "CoderAgent")
    manager.send_message("session-a", "coder", "please implement")
    request = manager.request_shutdown("session-a", "coder")

    role = AgentRole(name="CoderAgent", description="coder")
    with execution_scope("session-a"), role_scope(role):
        inbox = REGISTRY.execute_by_name("team_message_list", {})
        response = REGISTRY.execute_by_name(
            "team_shutdown_respond",
            {"request_id": request["request_id"], "approve": True},
        )

    assert inbox.success is True
    assert json.loads(inbox.output)["data"]["member"] == "coder"
    assert response.success is True
    assert json.loads(response.output)["data"]["status"] == "approved"


def test_subagent_tool_allowlist_includes_only_safe_team_communication():
    agent = SubAgent()
    agent.tools = ["read_file"]
    names = {item["function"]["name"] for item in agent._allowed_tools()}

    assert {"team_message_send", "team_message_list", "team_shutdown_respond"} <= names
    assert "team_create" not in names
    assert "team_delete" not in names
    assert "team_member_remove" not in names


def test_bridge_team_lifecycle_and_session_close_gate(tmp_path: Path):
    runtime = SessionRuntime(lambda _event: None, agent_factory=NoopAgent)
    actions = ActionRuntime(tmp_path)
    session_id = runtime.create_session()["session_id"]

    created = dispatch(
        {
            "version": "1.2",
            "method": "team.create",
            "params": {"session_id": session_id, "name": "Bridge Team"},
        },
        runtime=runtime,
        actions=actions,
    )
    added = dispatch(
        {
            "version": "1.2",
            "method": "team.member.add",
            "params": {
                "session_id": session_id,
                "member_name": "coder",
                "role": "CoderAgent",
            },
        },
        runtime=runtime,
        actions=actions,
    )
    blocked_close = dispatch(
        {
            "version": "1.2",
            "method": "session.close",
            "params": {"session_id": session_id},
        },
        runtime=runtime,
        actions=actions,
    )
    blocked_delete = dispatch(
        {
            "version": "1.2",
            "method": "team.delete",
            "params": {"session_id": session_id},
        },
        runtime=runtime,
        actions=actions,
    )

    assert created["ok"] is True
    assert added["ok"] is True
    assert blocked_close["error"]["code"] == "SESSION_BUSY"
    assert blocked_delete["error"]["code"] == "MEMBER_ACTIVE"


def test_bridge_rejects_unknown_team_parameters(tmp_path: Path):
    runtime = SessionRuntime(lambda _event: None, agent_factory=NoopAgent)
    session_id = runtime.create_session()["session_id"]
    response = dispatch(
        {
            "version": "1.2",
            "method": "team.create",
            "params": {
                "session_id": session_id,
                "name": "Team",
                "unexpected": True,
            },
        },
        runtime=runtime,
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "INVALID_PARAMS"
