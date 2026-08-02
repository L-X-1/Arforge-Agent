"""Test B4: 8 concrete SubAgent implementations.

Verifies each SubAgent:
- Correct role, capabilities, tools metadata
- get_role() returns valid AgentRole
- execute() completes successfully with mocked model
- _run() handles empty dependencies gracefully
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch


from arforge.multiagent.agents.coder_agent import CoderAgent
from arforge.multiagent.agents.data_agent import DataAgent
from arforge.multiagent.agents.debugger_agent import DebuggerAgent
from arforge.multiagent.agents.doc_agent import DocAgent
from arforge.multiagent.agents.planner_agent import PlannerAgent
from arforge.multiagent.agents.reviewer_agent import ReviewerAgent
from arforge.multiagent.agents.searcher_agent import SearcherAgent
from arforge.multiagent.agents.tester_agent import TesterAgent
from arforge.multiagent.protocol import AgentRole, Conversation, Task


# ====================================================================
# Helper
# ====================================================================


def _mock_execute(agent_cls, task_goal="Test goal", deps=None, inputs=None):
    """Run execute() on an agent with mocked _call_model."""
    agent = agent_cls()
    task = Task(role=agent.role, goal=task_goal, depends_on=deps or [], inputs=inputs or {})
    conv = Conversation(master_goal=task_goal)
    with patch.object(agent, "_call_model", return_value="Mocked response"):
        return agent.execute(task, conv)


# ====================================================================
# PlannerAgent
# ====================================================================


class TestPlannerAgent:
    def test_metadata(self):
        assert PlannerAgent.role == "PlannerAgent"
        assert "planning" in PlannerAgent.capabilities
        assert "read_file" in PlannerAgent.tools

    def test_get_role(self):
        role = PlannerAgent.get_role()
        assert isinstance(role, AgentRole)
        assert role.name == "PlannerAgent"

    def test_execute_returns_result(self):
        result = _mock_execute(PlannerAgent, "规划一个 Web 应用架构")
        assert result.success is True
        assert result.role == "PlannerAgent"
        assert len(result.output) > 0

    def test_run_with_empty_goal(self):
        agent = PlannerAgent()
        task = Task(role="PlannerAgent", goal="空")
        conv = Conversation(master_goal="空")
        with patch.object(agent, "_call_model", return_value="Fallback plan"):
            result = agent.execute(task, conv)
            assert result.success is True


# ====================================================================
# CoderAgent
# ====================================================================


class TestCoderAgent:
    def test_metadata(self):
        assert CoderAgent.role == "CoderAgent"
        assert "safe_modify" in CoderAgent.capabilities
        assert "write_file" in CoderAgent.tools

    def test_get_role(self):
        role = CoderAgent.get_role()
        assert isinstance(role, AgentRole)
        assert role.name == "CoderAgent"

    def test_execute_returns_result(self):
        result = _mock_execute(CoderAgent, "实现一个快速排序函数")
        assert result.success is True
        assert result.role == "CoderAgent"

    def test_uses_dependency_context(self):
        """Should include dependency results in prompt."""
        agent = CoderAgent()
        dep_result = MagicMock(success=True, output="Found: sort.py:10-20", role="SearcherAgent")
        conv = Conversation(
            master_goal="Fix sort",
            tasks=[
                Task(task_id="t1", role="SearcherAgent", goal="Search sort"),
                Task(task_id="t2", role="CoderAgent", goal="Fix sort", depends_on=["t1"]),
            ],
            results=[dep_result],
        )
        # Verify _run uses dep context via _build_prompt
        task = conv.tasks[1]
        messages = agent._build_prompt(task, conv)
        # The default _run appends an extra user message; test that build_prompt includes it
        system_and_user = " ".join(m["content"] for m in messages)
        assert "sort" in system_and_user.lower()


# ====================================================================
# ReviewerAgent
# ====================================================================


class TestReviewerAgent:
    def test_metadata(self):
        assert ReviewerAgent.role == "ReviewerAgent"
        assert "security_review" in ReviewerAgent.capabilities
        assert "read_file" in ReviewerAgent.tools

    def test_get_role(self):
        role = ReviewerAgent.get_role()
        assert isinstance(role, AgentRole)
        assert role.name == "ReviewerAgent"

    def test_execute_returns_result(self):
        result = _mock_execute(ReviewerAgent, "审查这段代码：def foo(): pass")
        assert result.success is True
        assert result.role == "ReviewerAgent"


# ====================================================================
# TesterAgent
# ====================================================================


class TestTesterAgent:
    def test_metadata(self):
        assert TesterAgent.role == "TesterAgent"
        assert "test_generation" in TesterAgent.capabilities
        assert "run_cmd" in TesterAgent.tools

    def test_get_role(self):
        role = TesterAgent.get_role()
        assert isinstance(role, AgentRole)
        assert role.name == "TesterAgent"

    def test_execute_returns_result(self):
        result = _mock_execute(TesterAgent, "为 sort 函数写测试")
        assert result.success is True

    def test_count_test_functions(self):
        agent = TesterAgent()
        task = Task(role="TesterAgent", goal="Write tests for sort")
        conv = Conversation(master_goal="Write tests")
        with patch.object(agent, "_call_model", return_value="def test_sort_empty():\n    pass\n\ndef test_sort_single():\n    pass"):
            output, artifacts, evidence, tool_calls = agent._run(task, conv)
            assert artifacts.get("test_count", 0) == 2


# ====================================================================
# SearcherAgent
# ====================================================================


class TestSearcherAgent:
    def test_metadata(self):
        assert SearcherAgent.role == "SearcherAgent"
        assert "memory_search" in SearcherAgent.capabilities
        assert "list_files" in SearcherAgent.tools

    def test_get_role(self):
        role = SearcherAgent.get_role()
        assert isinstance(role, AgentRole)
        assert role.name == "SearcherAgent"

    def test_execute_returns_result(self):
        result = _mock_execute(SearcherAgent, "搜索 memory.py 中的 dedupe 函数")
        assert result.success is True
        assert result.role == "SearcherAgent"


# ====================================================================
# DocAgent
# ====================================================================


class TestDocAgent:
    def test_metadata(self):
        assert DocAgent.role == "DocAgent"
        assert "multimodal_inspection" in DocAgent.capabilities
        assert "write_file" in DocAgent.tools

    def test_get_role(self):
        role = DocAgent.get_role()
        assert isinstance(role, AgentRole)
        assert role.name == "DocAgent"

    def test_execute_returns_result(self):
        result = _mock_execute(DocAgent, "为 cli.py 生成 API 文档")
        assert result.success is True
        assert result.role == "DocAgent"


# ====================================================================
# DebuggerAgent
# ====================================================================


class TestDebuggerAgent:
    def test_metadata(self):
        assert DebuggerAgent.role == "DebuggerAgent"
        assert "safe_modify" in DebuggerAgent.capabilities
        assert "run_cmd" in DebuggerAgent.tools

    def test_get_role(self):
        role = DebuggerAgent.get_role()
        assert isinstance(role, AgentRole)
        assert role.name == "DebuggerAgent"

    def test_execute_returns_result(self):
        result = _mock_execute(
            DebuggerAgent,
            "TypeError: 'NoneType' object is not callable in agent_core.py:120",
            inputs={"error": "TypeError at agent_core.py:120"},
        )
        assert result.success is True
        assert result.role == "DebuggerAgent"


# ====================================================================
# DataAgent
# ====================================================================


class TestDataAgent:
    def test_metadata(self):
        assert DataAgent.role == "DataAgent"
        # P0-1 修复：DataAgent 无 run_cmd 工具，故不应声明 command_execution
        assert "data_analysis" in DataAgent.capabilities
        assert "command_execution" not in DataAgent.capabilities
        assert "read_file" in DataAgent.tools

    def test_get_role(self):
        role = DataAgent.get_role()
        assert isinstance(role, AgentRole)
        assert role.name == "DataAgent"

    def test_execute_returns_result(self):
        result = _mock_execute(DataAgent, "分析 token 用量趋势")
        assert result.success is True
        assert result.role == "DataAgent"


# ====================================================================
# All agents registered correctly
# ====================================================================


class TestAllAgentsRegistration:
    """Verify all 8 agents can be imported and have unique roles."""

    def test_all_eight_agents_defined(self):
        agents = [
            PlannerAgent,
            CoderAgent,
            ReviewerAgent,
            TesterAgent,
            SearcherAgent,
            DocAgent,
            DebuggerAgent,
            DataAgent,
        ]
        roles = [a.role for a in agents]
        assert len(roles) == len(set(roles)), f"Duplicate roles: {roles}"
        assert len(agents) == 8

    def test_all_agents_have_system_prompt(self):
        agents = [
            PlannerAgent, CoderAgent, ReviewerAgent, TesterAgent,
            SearcherAgent, DocAgent, DebuggerAgent, DataAgent,
        ]
        for agent_cls in agents:
            assert agent_cls.system_prompt, f"{agent_cls.__name__} missing system_prompt"

    def test_all_agents_have_capabilities(self):
        agents = [
            PlannerAgent, CoderAgent, ReviewerAgent, TesterAgent,
            SearcherAgent, DocAgent, DebuggerAgent, DataAgent,
        ]
        for agent_cls in agents:
            assert len(agent_cls.capabilities) > 0, f"{agent_cls.__name__} has no capabilities"

    def test_all_agents_can_be_instantiated(self):
        agents = [
            PlannerAgent, CoderAgent, ReviewerAgent, TesterAgent,
            SearcherAgent, DocAgent, DebuggerAgent, DataAgent,
        ]
        for agent_cls in agents:
            agent = agent_cls()
            assert agent.role == agent_cls.role
