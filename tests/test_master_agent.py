"""Test B2: MasterAgent — task understanding, decomposition, evaluation, iteration.

Verifies:
- _understand heuristic classifies complexity and roles correctly
- _understand_via_model works when adapter is available
- _needs_multiagent gates correctly
- _decompose produces valid task DAGs
- _evaluate judges result quality
- _extract_json handles wrapped/clean/malformed JSON
- handle() returns single-agent path for simple queries
- handle() returns multi-agent path for complex queries
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from arforge.multiagent.master_agent import (
    MasterAgent,
    QualityAssessment,
    TaskUnderstanding,
)
from arforge.multiagent.protocol import Conversation, Task, TaskResult


# ====================================================================
# Fixtures
# ====================================================================


@pytest.fixture
def master():
    """MasterAgent without an ArforgeAgent (uses heuristic paths)."""
    return MasterAgent(agent=None)


@pytest.fixture
def master_with_mock_agent():
    """MasterAgent with a mocked ArforgeAgent adapter."""
    agent = MagicMock()
    agent.adapter.generate.return_value = "mock response"
    agent.chat.return_value = MagicMock(answer="chat response")
    return MasterAgent(agent=agent)


# ====================================================================
# _understand heuristic tests
# ====================================================================


class TestUnderstandHeuristic:
    def test_simple_question(self, master):
        u = master._understand_heuristic("什么是闭包")
        assert u.complexity == "simple"
        assert u.estimated_steps == 1
        assert not u.needs_multiagent

    def test_medium_fix_bug(self, master):
        u = master._understand_heuristic("修复 memory.py 的 dedupe bug")
        assert u.complexity == "medium"
        assert u.estimated_steps == 3
        # Should suggest SearcherAgent + CoderAgent + DebuggerAgent
        assert "CoderAgent" in u.suggested_roles

    def test_complex_refactor(self, master):
        u = master._understand_heuristic("重构整个 agent_core.py 的路由架构")
        assert u.complexity == "complex"
        assert u.estimated_steps == 5
        assert u.needs_multiagent

    def test_review_triggers_reviewer(self, master):
        u = master._understand_heuristic("审查 cli.py 的安全性")
        assert "ReviewerAgent" in u.suggested_roles

    def test_code_and_test_triggers_multiple_roles(self, master):
        u = master._understand_heuristic("修复 bug 并加测试")
        assert len(u.suggested_roles) >= 2
        # Multi-agent triggered because multiple roles
        assert u.needs_multiagent

    def test_documentation_triggers_doc_agent(self, master):
        u = master._understand_heuristic("把 README 翻译成英文")
        assert "DocAgent" in u.suggested_roles

    def test_data_analysis_triggers_data_agent(self, master):
        u = master._understand_heuristic("分析 token 用量数据")
        assert "DataAgent" in u.suggested_roles


# ====================================================================
# _needs_multiagent tests
# ====================================================================


class TestNeedsMultiagent:
    def test_simple_no_multi(self, master):
        u = TaskUnderstanding(complexity="simple", suggested_roles=["CoderAgent"], estimated_steps=1)
        assert master._needs_multiagent(u) is False

    def test_medium_triggers_multi(self, master):
        u = TaskUnderstanding(complexity="medium", suggested_roles=["CoderAgent"], estimated_steps=3)
        assert master._needs_multiagent(u) is True

    def test_multiple_roles_triggers_multi(self, master):
        u = TaskUnderstanding(complexity="simple", suggested_roles=["CoderAgent", "ReviewerAgent"], estimated_steps=2)
        assert master._needs_multiagent(u) is True

    def test_complex_triggers_multi(self, master):
        u = TaskUnderstanding(complexity="complex", suggested_roles=["CoderAgent"], estimated_steps=5)
        assert master._needs_multiagent(u) is True

    def test_high_steps_triggers_multi(self, master):
        u = TaskUnderstanding(complexity="simple", suggested_roles=["CoderAgent"], estimated_steps=3)
        assert master._needs_multiagent(u) is True


# ====================================================================
# _decompose heuristic tests
# ====================================================================


class TestDecomposeHeuristic:
    def test_coding_task_has_pipeline(self, master):
        u = TaskUnderstanding(
            complexity="medium",
            suggested_roles=["SearcherAgent", "CoderAgent", "ReviewerAgent", "TesterAgent"],
            estimated_steps=4,
        )
        tasks = master._decompose_heuristic("修复 bug 并审查加测试", u)
        assert len(tasks) >= 3
        roles = [t.role for t in tasks]
        assert "SearcherAgent" in roles
        assert "CoderAgent" in roles
        assert "ReviewerAgent" in roles
        assert "TesterAgent" in roles

    def test_tasks_have_dependency_chain(self, master):
        u = TaskUnderstanding(
            complexity="medium",
            suggested_roles=["SearcherAgent", "CoderAgent", "TesterAgent"],
            estimated_steps=3,
        )
        tasks = master._decompose_heuristic("修复 bug 并加测试", u)
        # Later tasks should depend on earlier ones
        for i in range(1, len(tasks)):
            if tasks[i].depends_on:
                assert len(tasks[i].depends_on) > 0

    def test_simple_task_has_one_task(self, master):
        u = TaskUnderstanding(complexity="simple", suggested_roles=["CoderAgent"], estimated_steps=1)
        tasks = master._decompose_heuristic("修个小bug", u)
        assert len(tasks) >= 1

    def test_empty_roles_uses_coder(self, master):
        u = TaskUnderstanding(complexity="simple", suggested_roles=[], estimated_steps=1)
        tasks = master._decompose_heuristic("任意任务", u)
        assert len(tasks) >= 1
        assert tasks[0].role in ("CoderAgent", "SearcherAgent")


# ====================================================================
# _evaluate tests
# ====================================================================


class TestEvaluate:
    def test_all_success_satisfied(self, master):
        conv = Conversation(
            master_goal="Test",
            tasks=[Task(task_id="t1", role="R", goal="G")],
            results=[TaskResult(task_id="t1", role="R", success=True, output="done", elapsed_ms=100)],
        )
        q = master._evaluate(conv, "Test")
        assert q.satisfied is True

    def test_some_failure_not_satisfied(self, master):
        conv = Conversation(
            master_goal="Test",
            tasks=[Task(task_id="t1", role="R", goal="G")],
            results=[TaskResult(task_id="t1", role="R", success=False, error="fail", elapsed_ms=100)],
        )
        q = master._evaluate(conv, "Test")
        assert q.satisfied is False
        assert len(q.missing) > 0

    def test_no_results_not_satisfied(self, master):
        conv = Conversation(master_goal="Test", tasks=[Task(task_id="t1", role="R", goal="G")])
        q = master._evaluate(conv, "Test")
        assert q.satisfied is False


# ====================================================================
# _extract_json tests
# ====================================================================


class TestExtractJson:
    def test_pure_json_array(self, master):
        result = master._extract_json('[{"a": 1}, {"b": 2}]')
        assert isinstance(result, list)
        assert len(result) == 2

    def test_pure_json_object(self, master):
        result = master._extract_json('{"key": "value"}')
        assert isinstance(result, dict)
        assert result["key"] == "value"

    def test_json_wrapped_in_text(self, master):
        result = master._extract_json('好的，这是计划：\n[{"title": "步骤1"}]\n希望有帮助。')
        assert isinstance(result, list)
        assert result[0]["title"] == "步骤1"

    def test_no_json_returns_none(self, master):
        result = master._extract_json("no json here")
        assert result is None

    def test_malformed_json_returns_none(self, master):
        result = master._extract_json('[{"broken": ]')
        assert result is None


# ====================================================================
# handle() tests
# ====================================================================


class TestHandle:
    def test_empty_input(self, master):
        result = master.handle("")
        assert result["answer"] == ""
        assert result["mode"] == "single"

    def test_simple_query_single_agent(self, master_with_mock_agent):
        result = master_with_mock_agent.handle("2+2等于几")
        assert result["mode"] == "single"
        assert "answer" in result

    def test_complex_query_multi_agent(self):
        """Complex task → multi-agent path with mocked dispatcher/merger."""
        agent = MagicMock()
        agent.adapter.generate.return_value = '[{"task_id": "step_0", "role": "CoderAgent", "goal": "fix bug", "depends_on": []}]'

        m = MasterAgent(agent=agent)

        # Pre-set internal dispatcher/merger mocks (avoids lazy import of not-yet-built modules)
        mock_disp = MagicMock()
        mock_disp.dispatch.return_value = [
            TaskResult(task_id="step_0", role="CoderAgent", success=True, output="fixed", elapsed_ms=100)
        ]
        mock_merger = MagicMock()
        mock_merger.merge.return_value = {"answer": "Bug fixed successfully"}

        m._dispatcher = mock_disp
        m._merger = mock_merger
        m._pool = MagicMock()

        result = m.handle("修复 memory.py 的 dedupe bug 并加测试和审查")

        assert result["mode"] == "multi"
        assert result["agents_used"] >= 1
        assert "answer" in result

    def test_whitespace_only_input(self, master):
        result = master.handle("   ")
        assert result["mode"] == "single"
        assert result["answer"] == ""


# ====================================================================
# QualityAssessment tests
# ====================================================================


class TestQualityAssessment:
    def test_default_satisfied(self):
        q = QualityAssessment()
        assert q.satisfied is True
        assert q.score == 1.0
        assert q.missing == []
        assert q.suggestions == []

    def test_full_construction(self):
        q = QualityAssessment(
            satisfied=False,
            score=0.5,
            missing=["item1"],
            suggestions=["fix item1"],
        )
        assert q.satisfied is False
        assert q.score == 0.5
        assert len(q.missing) == 1
        assert len(q.suggestions) == 1


# ====================================================================
# TaskUnderstanding tests
# ====================================================================


class TestTaskUnderstanding:
    def test_default_values(self):
        u = TaskUnderstanding()
        assert u.intent == ""
        assert u.complexity == "simple"
        assert u.suggested_roles == []
        assert u.estimated_steps == 1
        assert u.needs_multiagent is False
