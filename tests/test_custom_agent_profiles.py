"""Contract coverage for project-scoped specialized agent profiles."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest


def _payload(**overrides):
    payload = {
        "schema_version": 1,
        "name": "release-reviewer",
        "description": "Reviews release changes against the established engineering policy.",
        "system_prompt": "Review the supplied change carefully. Report concrete issues with evidence and do not bypass the active permission policy.",
        "tools": ["read_file"],
        "capabilities": ["code_review"],
        "max_steps": 6,
        "max_tokens": 2048,
        "timeout_seconds": 45,
    }
    payload.update(overrides)
    return payload


def test_parser_rejects_unknown_fields_and_unknown_tools():
    from arforge.custom_agent_profiles import CustomAgentProfileError, parse_custom_agent_profile

    with pytest.raises(CustomAgentProfileError, match="unsupported fields"):
        parse_custom_agent_profile(_payload(command="powershell"))
    with pytest.raises(CustomAgentProfileError, match="tools contains unsupported values"):
        parse_custom_agent_profile(_payload(tools=["not_a_registered_tool"]))


def test_discovery_rejects_duplicate_names_without_executing_project_code(tmp_path):
    from arforge.custom_agent_profiles import discover_custom_agent_profiles

    root = tmp_path / ".arforge" / "agents"
    root.mkdir(parents=True)
    (root / "one.json").write_text(json.dumps(_payload()), encoding="utf-8")
    (root / "two.json").write_text(
        json.dumps(_payload(description="A separate valid description.")),
        encoding="utf-8",
    )

    profiles, errors = discover_custom_agent_profiles(tmp_path)

    assert [profile.name for profile in profiles] == ["release-reviewer"]
    assert errors and "duplicate profile name" in errors[0]["error"]


def test_runtime_profile_loading_requires_explicit_enablement_and_trust(monkeypatch, tmp_path):
    from arforge.custom_agent_profiles import load_enabled_custom_agent_profiles

    root = tmp_path / ".arforge" / "agents"
    root.mkdir(parents=True)
    (root / "review.json").write_text(json.dumps(_payload()), encoding="utf-8")
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.delenv("ARFORGE_ENABLE_CUSTOM_AGENTS", raising=False)
    assert load_enabled_custom_agent_profiles(tmp_path) == ([], [])

    monkeypatch.setenv("ARFORGE_ENABLE_CUSTOM_AGENTS", "1")
    assert load_enabled_custom_agent_profiles(tmp_path) == ([], [])
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    profiles, errors = load_enabled_custom_agent_profiles(tmp_path)
    assert errors == []
    assert [profile.role_name for profile in profiles] == ["CustomAgent.release-reviewer"]


def test_pool_refreshes_enabled_profile_without_replacing_builtin_roles(monkeypatch, tmp_path):
    from arforge.multiagent.sub_agent_pool import get_sub_agent_pool

    root = tmp_path / ".arforge" / "agents"
    root.mkdir(parents=True)
    (root / "review.json").write_text(json.dumps(_payload()), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ARFORGE_ENABLE_CUSTOM_AGENTS", "1")
    monkeypatch.setenv("ARFORGE_TRUST_WORKSPACE", "1")
    pool = get_sub_agent_pool()
    pool.reset()
    pool = get_sub_agent_pool()
    try:
        agent = pool.create_agent("CustomAgent.release-reviewer")
        assert agent is not None
        assert agent.role == "CustomAgent.release-reviewer"
        assert agent.tools == ["read_file"]
        assert agent.max_steps == 6
        assert pool.create_agent("CoderAgent") is not None
    finally:
        pool.reset()


def test_model_understanding_sees_custom_roles_and_filters_unknown_roles(monkeypatch):
    from arforge.multiagent.master_agent import MasterAgent
    import arforge.models.structured as structured

    master = object.__new__(MasterAgent)
    master._pool = SimpleNamespace(list_role_names=lambda: ["CoderAgent", "CustomAgent.release-reviewer"])
    master.agent = SimpleNamespace(adapter=object())
    master._json_stats = {"understand_ok": 0, "understand_fail": 0}
    captured = {}

    def generate(_adapter, messages, **_kwargs):
        captured["prompt"] = messages[0]["content"]
        return {
            "intent": "review a release",
            "complexity": "medium",
            "suggested_roles": ["CustomAgent.release-reviewer", "missing-role"],
            "estimated_steps": 2,
            "needs_multiagent": True,
        }

    monkeypatch.setattr(structured, "generate_structured", generate)
    result = master._understand_via_model("Review the current release.")

    assert "CustomAgent.release-reviewer" in captured["prompt"]
    assert result.suggested_roles == ["CustomAgent.release-reviewer"]


def test_cli_lists_and_validates_profiles(monkeypatch, tmp_path, capsys):
    from arforge.cli import main

    root = tmp_path / ".arforge" / "agents"
    root.mkdir(parents=True)
    profile_path = root / "review.json"
    profile_path.write_text(json.dumps(_payload()), encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["custom-agents", "list", "--json"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed["profiles"][0]["role"] == "CustomAgent.release-reviewer"
    assert main(["custom-agents", "validate", str(profile_path), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["valid"] is True


def test_legacy_cli_custom_agents_status_reads_the_typescript_workspace_owner(monkeypatch, tmp_path, capsys):
    """The migration-era helper must not consult the retired Python trust store."""

    from arforge import cli
    import arforge.custom_agent_profiles as profiles

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(profiles, "typescript_workspace_trusted", lambda _workspace: True)
    monkeypatch.setattr(profiles, "custom_agents_enabled", lambda _workspace: False)

    assert cli.main(["custom-agents", "status", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["workspace_trusted"] is True
    assert payload["enabled"] is False


def test_direct_dispatch_custom_agent_report_uses_ts_owner(monkeypatch, tmp_path):
    """The migration-era direct adapter must not rebuild the Python profile report."""

    import arforge.cli_compat as cli_compat
    import arforge.custom_agent_profiles as profiles
    from arforge.product import direct_dispatch as bridge

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        profiles,
        "typescript_custom_agents_status",
        lambda _workspace: {
            "directory": str(tmp_path / ".arforge" / "agents"),
            "workspace_trusted": True,
            "enabled": True,
        },
    )
    monkeypatch.setattr(
        cli_compat,
        "invoke",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"profiles": [{"role": "CustomAgent.review"}], "errors": []}),
        ),
    )

    result = bridge._dispatch_product("custom_agents.list", {}, None, None, None, None)

    assert result["workspace"] == str(tmp_path.resolve())
    assert result["workspace_trusted"] is True
    assert result["enabled"] is True
    assert result["profiles"] == [{"role": "CustomAgent.review"}]
    assert result["errors"] == []
