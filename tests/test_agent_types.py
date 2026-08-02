"""Tests for agent_types.py — enhanced sub-agent type library."""
from arforge.multiagent.agent_types import (
    AgentTypeDef,
    get_builtin_agents,
    get_agent_type,
    register_agent_type,
    list_agent_types,
)


class TestAgentTypeDef:
    def test_creation_defaults(self):
        at = AgentTypeDef(agent_type="test", when_to_use="For testing")
        assert at.agent_type == "test"
        assert at.tools == []
        assert at.max_steps == 25
        assert at.permission_mode == "acceptEdits"
        assert at.model == "inherit"

    def test_to_dict(self):
        at = AgentTypeDef(agent_type="test", when_to_use="Testing", tools=["read_file"])
        d = at.to_dict()
        assert d["agent_type"] == "test"
        assert d["tools"] == ["read_file"]

    def test_custom_system_prompt(self):
        at = AgentTypeDef(
            agent_type="custom",
            when_to_use="Custom agent",
            get_system_prompt=lambda: "Custom system prompt",
        )
        assert at.get_system_prompt() == "Custom system prompt"


class TestBuiltinAgents:
    def test_all_builtins_have_agent_type(self):
        for at in get_builtin_agents():
            assert at.agent_type
            assert at.when_to_use
            assert at.max_steps > 0
            assert at.permission_mode in ("plan", "acceptEdits", "autoApprove")

    def test_general_purpose(self):
        at = get_agent_type("general")
        assert at is not None
        assert at.agent_type == "general"
        assert "General-purpose" in at.when_to_use or "general" in at.when_to_use.lower()

    def test_explorer_is_read_only(self):
        at = get_agent_type("explorer")
        assert at is not None
        assert at.permission_mode == "plan"

    def test_planner_has_plan_tools(self):
        at = get_agent_type("planner")
        assert at is not None
        assert "read_file" in at.tools
        assert "code_search" in at.tools

    def test_verifier_has_test_tool(self):
        at = get_agent_type("verifier")
        assert at is not None
        assert "run_tests" in at.tools

    def test_statusline_is_fast(self):
        at = get_agent_type("statusline")
        assert at is not None
        assert at.max_steps <= 5

    def test_get_nonexistent(self):
        assert get_agent_type("nonexistent") is None

    def test_register_custom(self):
        custom = AgentTypeDef(agent_type="my_agent", when_to_use="My custom agent")
        register_agent_type(custom)
        assert get_agent_type("my_agent") is not None
        assert "my_agent" in list_agent_types()

    def test_list_agent_types_includes_builtins(self):
        names = list_agent_types()
        assert "general" in names
        assert "explorer" in names
        assert "planner" in names
        assert "verifier" in names
        assert "statusline" in names
