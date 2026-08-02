from __future__ import annotations

from pathlib import Path

import pytest

from arforge.workspace_context import execution_scope


def _write_rules(path: Path, marker: str) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    rules = path / "ARFORGE.md"
    rules.write_text(f"# Project Rules\n\n{marker}\n", encoding="utf-8")
    return rules


def test_finds_nearest_project_rules_from_nested_workspace(tmp_path):
    from arforge.project_rules import load_project_rules

    expected = _write_rules(tmp_path / "project", "nearest-marker")
    nested = expected.parent / "src" / "feature"
    nested.mkdir(parents=True)

    with execution_scope("project-rules-nearest", workspace=nested):
        rules = load_project_rules(required=True)

    assert rules is not None
    assert rules.path == expected
    assert "nearest-marker" in rules.content


def test_agent_reads_rules_fresh_before_memory_and_skill_routing(tmp_path, monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    workspace = tmp_path / "project"
    rules_path = _write_rules(workspace, "rules-v1")
    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)

    def refresh_memory(_query):
        agent.memory_text = "memory-marker"
        return agent.memory_text

    monkeypatch.setattr(agent, "refresh_memory_text", refresh_memory)
    monkeypatch.setattr(
        "arforge.skill_runtime.build_skill_system_prompt",
        lambda _request: "skill-route-marker",
    )

    with execution_scope("project-rules-fresh", workspace=workspace):
        first = agent.build_messages("实现一个登录功能。")[0]["content"]
        rules_path.write_text("# Project Rules\n\nrules-v2\n", encoding="utf-8")
        second = agent.build_messages("实现一个登录功能。")[0]["content"]

    assert "rules-v1" in first
    assert "rules-v2" not in first
    assert "rules-v2" in second
    assert "rules-v1" not in second
    assert second.index("rules-v2") < second.index("memory-marker")
    assert second.index("rules-v2") < second.index("skill-route-marker")


def test_development_request_fails_closed_without_arforge_md(tmp_path, monkeypatch):
    from arforge.core.agent_core import ArforgeAgent
    from arforge.project_rules import ProjectRulesError

    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    monkeypatch.setattr(agent, "refresh_memory_text", lambda _query: "")

    with execution_scope("project-rules-missing", workspace=tmp_path):
        with pytest.raises(ProjectRulesError, match="ARFORGE.md was not found"):
            agent.build_messages("请实现用户登录功能。")


def test_non_development_chat_remains_available_without_project_rules(tmp_path, monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    monkeypatch.setattr(agent, "refresh_memory_text", lambda _query: "")

    with execution_scope("project-rules-chat", workspace=tmp_path):
        messages = agent.build_messages("你好")

    assert messages[-1]["role"] == "user"


def test_recognized_project_fails_closed_even_when_request_is_just_continue(
    tmp_path,
    monkeypatch,
):
    from arforge.core.agent_core import ArforgeAgent
    from arforge.project_rules import ProjectRulesError

    (tmp_path / "package.json").write_text("{}\n", encoding="utf-8")
    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    monkeypatch.setattr(agent, "refresh_memory_text", lambda _query: "")

    with execution_scope("project-rules-project-marker", workspace=tmp_path):
        with pytest.raises(ProjectRulesError, match="ARFORGE.md was not found"):
            agent.build_messages("继续")


def test_model_call_reports_project_rules_block_without_api_key_advice(tmp_path, monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    monkeypatch.setattr(agent, "refresh_memory_text", lambda _query: "")

    with execution_scope("project-rules-model-error", workspace=tmp_path):
        result = agent.call_model("请实现用户登录功能。")

    assert "Project development blocked" in result
    assert "ARFORGE.md was not found" in result
    assert "API key" not in result


def test_stream_reports_a_specific_project_rules_error(tmp_path, monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    monkeypatch.setattr(agent, "refresh_memory_text", lambda _query: "")

    with execution_scope("project-rules-stream-error", workspace=tmp_path):
        events = list(agent.chat_stream("请实现用户登录功能。"))

    assert events == [
        {
            "type": "error",
            "data": {
                "code": "PROJECT_RULES_REQUIRED",
                "message": (
                    "Project development is blocked because ARFORGE.md was not found "
                    f"from workspace {tmp_path.resolve()} or any parent directory."
                ),
            },
        }
    ]


def test_quick_plan_uses_the_same_mandatory_rules_path(tmp_path, monkeypatch):
    from arforge.core.agent_core import ArforgeAgent

    workspace = tmp_path / "project"
    _write_rules(workspace, "quick-plan-rules")
    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    monkeypatch.setattr(agent, "refresh_memory_text", lambda _query: "")

    captured: dict[str, list[dict]] = {}

    class Adapter:
        def generate(self, messages, **_kwargs):
            captured["messages"] = messages
            return "plan"

    agent._adapter = Adapter()
    with execution_scope("project-rules-plan", workspace=workspace):
        result = agent.quick_plan("实现支付功能")

    assert result == "plan"
    assert "quick-plan-rules" in captured["messages"][0]["content"]
