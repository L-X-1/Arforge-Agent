from __future__ import annotations

from arforge.bridge import dispatch
from arforge.core.hooks import HookContext, HookEvent, get_hook_manager, reset_hook_manager
from arforge.core.permission import install_permission_hooks, reset_permission_manager
from arforge.permission_profile import add_rule, list_rules, match_rule, revoke_rule


def test_permission_rule_add_match_and_revoke(tmp_path):
    store = tmp_path / "rules.json"
    rule = add_rule(
        subject="web_search",
        category="network",
        scope="workspace",
        decision="allow_always",
        reason="trusted source",
        path=store,
    )

    matched = match_rule(subject="web_search", category="network", scope="workspace", path=store)
    listed = list_rules(path=store)
    revoked = revoke_rule(rule.rule_id, path=store)

    assert matched == rule
    assert listed["count"] == 1
    assert listed["items"][0]["active"] is True
    assert revoked is not None
    assert revoked.revoked_at is not None
    assert list_rules(path=store)["count"] == 0
    assert list_rules(include_inactive=True, path=store)["items"][0]["active"] is False


def test_permission_rule_validation_rejects_bad_input(tmp_path):
    store = tmp_path / "rules.json"

    try:
        add_rule(subject="bad subject!", category="network", decision="allow_always", path=store)
    except ValueError as exc:
        assert "subject" in str(exc)
    else:
        raise AssertionError("bad subject should fail")

    try:
        add_rule(subject="tool", category="network", decision="maybe", path=store)
    except ValueError as exc:
        assert "decision must be one of" in str(exc)
    else:
        raise AssertionError("bad decision should fail")


def test_bridge_exposes_permission_rules(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    add_rule(subject="tool.read", category="read", decision="allow_always", reason="test")

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    response = dispatch({"id": 2, "version": "1.1", "method": "permissions.rules"})

    assert "permissions.rules" in described["data"]["methods"]
    assert response["ok"] is True
    assert response["data"]["count"] == 1
    assert response["data"]["items"][0]["subject"] == "tool.read"


def test_bridge_can_add_and_revoke_permission_rule(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    added = dispatch(
        {
            "id": 2,
            "version": "1.1",
            "method": "permissions.rule.add",
            "params": {
                "subject": "run_cmd:git",
                "category": "network",
                "decision": "allow_once",
                "scope": "workspace",
                "reason": "test",
            },
        }
    )
    rule_id = added["data"]["rule"]["rule_id"]
    revoked = dispatch(
        {
            "id": 3,
            "version": "1.1",
            "method": "permissions.rule.revoke",
            "params": {"rule_id": rule_id},
        }
    )

    assert "permissions.rule.add" in described["data"]["methods"]
    assert "permissions.rule.add" in described["data"]["mutating_methods"]
    assert added["ok"] is True
    assert added["data"]["rule"]["subject"] == "run_cmd:git"
    assert revoked["ok"] is True
    assert revoked["data"]["revoked"] is True


def test_cli_permissions_add_list_and_revoke(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    from arforge.cli import _run_permissions

    assert _run_permissions(["add", "web_search", "network", "allow_always"]) == 0
    add_output = capsys.readouterr().out
    assert "Permission Rule Added" in add_output
    rule_id = list_rules()["items"][0]["rule_id"]

    assert _run_permissions([]) == 0
    list_output = capsys.readouterr().out
    assert "web_search" in list_output
    assert "allow_always" in list_output

    assert _run_permissions(["revoke", rule_id]) == 0
    revoke_output = capsys.readouterr().out
    assert "Permission Rule Revoked" in revoke_output
    assert list_rules()["count"] == 0


def test_remembered_deny_blocks_runtime_permission_decider(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    reset_hook_manager()
    reset_permission_manager()
    install_permission_hooks("acceptEdits")
    add_rule(subject="run_cmd", category="workspace_cmd", decision="deny_always", reason="no shell")

    decision = get_hook_manager().fire(
        HookContext(
            HookEvent.PRE_TOOL_USE,
            tool_name="run_cmd",
            tool_args={"command": "echo hello"},
        )
    )

    assert decision.action == "block"
    assert "remembered rule" in decision.reason


def test_allow_once_is_consumed_by_runtime_permission_decider(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    reset_hook_manager()
    reset_permission_manager()
    install_permission_hooks("acceptEdits")
    rule = add_rule(
        subject="run_cmd:git",
        category="network",
        decision="allow_once",
        reason="one clone",
    )

    decision = get_hook_manager().fire(
        HookContext(
            HookEvent.PRE_TOOL_USE,
            tool_name="run_cmd",
            tool_args={"command": "git clone https://github.com/org/repo.git"},
        )
    )

    assert decision.action == "proceed"
    active = list_rules()["items"]
    inactive = list_rules(include_inactive=True)["items"]
    assert active == []
    assert inactive[0]["rule_id"] == rule.rule_id
    assert inactive[0]["active"] is False
