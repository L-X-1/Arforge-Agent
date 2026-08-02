"""Test B3: SubAgent base class + SubAgentPool registration and lifecycle.

Verifies:
- SubAgent base class default values
- SubAgent.get_role() returns correct AgentRole
- SubAgent._build_prompt() includes goal, inputs, dependencies
- SubAgent.execute() returns TaskResult on success and failure
- SubAgentPool singleton pattern
- Pool register / get / list_roles / is_registered
- Pool create_agent returns configured SubAgent
- register_sub_agent decorator
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch


from arforge.multiagent.protocol import AgentRole, Conversation, Task, TaskResult
from arforge.multiagent.sub_agent import SubAgent
from arforge.multiagent.sub_agent_pool import (
    SubAgentPool,
    get_sub_agent_pool,
    register_sub_agent,
)


# ====================================================================
# SubAgent base class tests
# ====================================================================


class TestSubAgentBase:
    def test_default_role_values(self):
        agent = SubAgent()
        assert agent.role == "BaseAgent"
        assert agent.capabilities == []
        assert agent.tools == []
        assert agent.system_prompt == ""
        assert agent.max_tokens == 4096
        assert agent.timeout == 0

    def test_get_role_returns_agent_role(self):
        """get_role() should return an AgentRole dataclass."""
        role = SubAgent.get_role()
        assert isinstance(role, AgentRole)
        assert role.name == "BaseAgent"
        assert role.capabilities == []

    def test_custom_role_class(self):
        """Subclass with custom role metadata."""

        class CustomAgent(SubAgent):
            role = "CustomAgent"
            capabilities = ["code_search", "safe_modify"]
            tools = ["read_file", "write_file"]
            system_prompt = "You are a custom agent."
            max_tokens = 8192

        role = CustomAgent.get_role()
        assert role.name == "CustomAgent"
        assert len(role.capabilities) == 2
        assert "safe_modify" in role.capabilities
        assert len(role.tools) == 2
        assert role.system_prompt == "You are a custom agent."
        assert role.max_tokens == 8192


class TestSubAgentBuildPrompt:
    def test_includes_goal(self):
        agent = SubAgent()
        agent.agentic_first = False
        task = Task(role="Test", goal="Fix a bug in memory.py")
        conv = Conversation(master_goal="Fix bug")
        messages = agent._build_prompt(task, conv)
        user = messages[1]["content"]
        assert "Fix a bug in memory.py" in user

    def test_includes_inputs(self):
        agent = SubAgent()
        agent.agentic_first = False
        task = Task(role="Test", goal="Analyze", inputs={"file": "main.py", "line": 42})
        conv = Conversation(master_goal="Analyze")
        messages = agent._build_prompt(task, conv)
        user = messages[1]["content"]
        assert "main.py" in user

    def test_includes_constraints(self):
        agent = SubAgent()
        agent.agentic_first = False
        task = Task(role="Test", goal="Modify", constraints=["no file writes", "read-only"])
        conv = Conversation(master_goal="Modify")
        messages = agent._build_prompt(task, conv)
        user = messages[1]["content"]
        assert "no file writes" in user

    def test_includes_dependency_results(self):
        agent = SubAgent()
        conv = Conversation(
            master_goal="Pipeline",
            tasks=[
                Task(task_id="t1", role="SearcherAgent", goal="Search"),
                Task(task_id="t2", role="CoderAgent", goal="Fix", depends_on=["t1"]),
            ],
            results=[
                TaskResult(task_id="t1", role="SearcherAgent", success=True, output="Found in memory.py:42"),
            ],
        )
        task = conv.tasks[1]
        messages = agent._build_prompt(task, conv)
        user = messages[1]["content"]
        assert "memory.py:42" in user

    def test_includes_system_prompt(self):
        agent = SubAgent()
        agent.system_prompt = "Be helpful."
        task = Task(role="Test", goal="Hi")
        conv = Conversation(master_goal="Hi")
        messages = agent._build_prompt(task, conv)
        assert messages[0]["content"] == "Be helpful."

    def test_includes_capabilities_in_system(self):
        agent = SubAgent()
        agent.capabilities = ["code_search", "safe_modify"]
        task = Task(role="Test", goal="Test")
        conv = Conversation(master_goal="Test")
        messages = agent._build_prompt(task, conv)
        system = messages[0]["content"]
        assert "code_search" in system
        assert "safe_modify" in system

    def test_includes_tools_in_system(self):
        agent = SubAgent()
        agent.tools = ["read_file", "write_file"]
        task = Task(role="Test", goal="Test")
        conv = Conversation(master_goal="Test")
        messages = agent._build_prompt(task, conv)
        system = messages[0]["content"]
        assert "read_file" in system


class TestSubAgentExecute:
    def test_successful_execution(self):
        """execute() should catch return value from _run()."""
        agent = SubAgent()
        agent.agentic_first = False
        task = Task(role="Test", goal="Say hello")
        conv = Conversation(master_goal="Hello")

        with patch.object(agent, "_call_model", return_value="Hello, world!"):
            result = agent.execute(task, conv)

        assert isinstance(result, TaskResult)
        assert result.success is True
        assert result.output == "Hello, world!"
        assert result.task_id == task.task_id
        assert result.role == "BaseAgent"
        assert result.elapsed_ms >= 0

    def test_failed_execution_caught(self):
        """execute() should catch exceptions and return failed TaskResult."""

        class FailingAgent(SubAgent):
            agentic_first = False
            def _run(self, task, conversation):
                raise ValueError("Something went wrong")

        agent = FailingAgent()
        task = Task(role="Test", goal="Will fail")
        conv = Conversation(master_goal="Fail")

        result = agent.execute(task, conv)
        assert isinstance(result, TaskResult)
        assert result.success is False
        assert "ValueError" in result.error
        assert "Something went wrong" in result.error

    def test_execute_has_elapsed_time(self):
        agent = SubAgent()
        agent.agentic_first = False
        task = Task(role="Test", goal="Test timing")
        conv = Conversation(master_goal="Timing")

        with patch.object(agent, "_call_model", return_value="ok"):
            result = agent.execute(task, conv)

        assert result.elapsed_ms >= 0
        assert result.elapsed_ms < 5000  # Should be fast


# ====================================================================
# SubAgentPool tests
# ====================================================================


class TestSubAgentPool:
    def setup_method(self):
        """Reset the pool singleton before each test."""
        SubAgentPool._instance = None

    def test_singleton(self):
        pool1 = get_sub_agent_pool()
        pool2 = get_sub_agent_pool()
        assert pool1 is pool2

    def test_list_role_names_has_defaults(self):
        pool = get_sub_agent_pool()
        names = pool.list_role_names()
        assert "CoderAgent" in names
        assert "ReviewerAgent" in names
        assert "TesterAgent" in names
        assert "SearcherAgent" in names
        assert "PlannerAgent" in names
        assert "DocAgent" in names
        assert "DebuggerAgent" in names
        assert "DataAgent" in names

    def test_list_roles_returns_agent_roles(self):
        pool = get_sub_agent_pool()
        roles = pool.list_roles()
        assert len(roles) >= 8
        for r in roles:
            assert isinstance(r, AgentRole)
            assert r.name
            assert r.description

    def test_is_registered_for_defaults(self):
        pool = get_sub_agent_pool()
        assert pool.is_registered("CoderAgent") is True
        assert pool.is_registered("NonexistentAgent") is False

    def test_register_custom_agent(self):
        class CustomAgent(SubAgent):
            role = "CustomAgent"
            capabilities = ["custom"]
            system_prompt = "Custom."

        pool = get_sub_agent_pool()
        pool.register(CustomAgent)

        assert pool.is_registered("CustomAgent") is True
        cls = pool.get("CustomAgent")
        assert cls is CustomAgent

    def test_create_agent_for_default_role(self):
        pool = get_sub_agent_pool()
        agent = pool.create_agent("CoderAgent")
        assert agent is not None
        assert agent.role == "CoderAgent"
        assert "safe_modify" in agent.capabilities
        assert "read_file" in agent.tools

    def test_create_agent_for_unknown_role(self):
        pool = get_sub_agent_pool()
        agent = pool.create_agent("UnknownRole")
        assert agent is None

    def test_register_sub_agent_decorator(self):
        @register_sub_agent
        class DecoratedAgent(SubAgent):
            role = "DecoratedAgent"
            capabilities = ["decorated"]

        pool = get_sub_agent_pool()
        assert pool.is_registered("DecoratedAgent")
        assert pool.get("DecoratedAgent") is DecoratedAgent

    def test_get_returns_none_for_unknown(self):
        pool = get_sub_agent_pool()
        assert pool.get("FakeAgent") is None

    def test_register_all(self):
        class AgentA(SubAgent):
            role = "AgentA"

        class AgentB(SubAgent):
            role = "AgentB"

        pool = get_sub_agent_pool()
        pool.register_all([AgentA, AgentB])

        assert pool.is_registered("AgentA")
        assert pool.is_registered("AgentB")
        assert pool.get("AgentA") is AgentA
        assert pool.get("AgentB") is AgentB

    def test_create_agent_passes_master(self):
        pool = get_sub_agent_pool()
        mock_master = MagicMock()
        agent = pool.create_agent("CoderAgent", master=mock_master)
        assert agent.master is mock_master
