from __future__ import annotations

from arforge.core import subagent
from arforge.tool_registry import REGISTRY


def test_permission_classifier_uses_subagent_role_category():
    import arforge.tools.subagent_tools  # noqa: F401
    from arforge.core.permission import classify_tool

    assert classify_tool("spawn_subagent", {"role": "reviewer"}) == "read"
    assert classify_tool("spawn_subagent", {"role": "test-writer"}) in ("workspace_write", "workspace_cmd", "dangerous")
    assert classify_tool("spawn_write_subagent", {"role": "debugger"}) == "workspace_cmd"
    assert classify_tool("spawn_write_subagent", {"role": "admin"}) == "dangerous"


def test_bridge_exposes_lightweight_subagent_roles():
    from arforge.bridge import dispatch

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    response = dispatch({"id": 2, "version": "1.1", "method": "subagents.roles"})

    assert "subagents.roles" in described["data"]["methods"]
    assert response["ok"] is True
    roles = {item["role"]: item for item in response["data"]["items"]}
    assert roles["reviewer"]["category"] == "read"
    assert roles["test-writer"]["category"] == "workspace_write"


def test_cli_agents_shows_lightweight_roles(capsys):
    from arforge.cli import _run_agents

    assert _run_agents() == 0
    output = capsys.readouterr().out

    assert "Multi-Agent Roles" in output
    assert "TesterAgent" in output
    assert "registered" in output


def test_role_bound_executor_does_not_share_global_role():
    subagent._set_current_role("test-writer")

    res = subagent._executor_for_role("explore")("write_file", {"filename": "x", "content": "y"})

    assert not res.success
    assert "role=explore" in res.error


def test_unknown_role_is_rejected():
    class FakeAdapter:
        model_name = "fake"

        def generate_with_tools(self, messages, tools=None, tool_choice="auto"):
            raise AssertionError("unknown role must be rejected before model call")

    subagent.set_subagent_adapter(FakeAdapter())
    try:
        out = subagent.run_subagent("scan", role="admin")
    finally:
        subagent.clear_subagent_adapter()

    assert "unknown subagent role" in out


def test_list_subagent_roles_exposes_permissions():
    roles = {item["role"]: item for item in subagent.list_subagent_roles()}

    assert roles["explore"]["category"] == "read"
    assert roles["reviewer"]["writable"] is False
    assert roles["test-writer"]["category"] == "workspace_write"
    assert "write_file" in roles["test-writer"]["tools"]
    assert roles["debugger"]["category"] == "workspace_cmd"
    assert roles["statusline"]["category"] == "workspace_cmd"
    assert roles["statusline"]["writable"] is False


def test_spawn_subagent_rejects_write_capable_role(monkeypatch):
    import arforge.tools.subagent_tools  # noqa: F401

    called = False

    def fake_run(task, role="explore"):
        nonlocal called
        called = True
        return "should not run"

    monkeypatch.setattr("arforge.core.subagent.run_subagent", fake_run)
    res = REGISTRY.execute_by_name("spawn_subagent", {"task": "write tests", "role": "test-writer"})

    assert res.success
    assert "not read-only" in res.output
    assert called is False


def test_spawn_write_subagent_allows_test_writer(monkeypatch):
    import arforge.tools.subagent_tools  # noqa: F401

    captured = {}

    def fake_run(task, role="test-writer"):
        captured["task"] = task
        captured["role"] = role
        return "tests written"

    monkeypatch.setattr("arforge.core.subagent.run_subagent", fake_run)
    res = REGISTRY.execute_by_name("spawn_write_subagent", {"task": "write tests", "role": "test-writer"})

    assert res.success
    assert res.output == "tests written"
    assert captured == {"task": "write tests", "role": "test-writer"}
