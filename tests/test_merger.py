"""Test B6: ResultMerger — single/pipeline/adversarial/llm_synthesis strategies.

Verifies:
- Single result pass-through
- Pipeline merge chains outputs in order
- Adversarial merge (Coder + Reviewer + Tester)
- LLM synthesis fallback (concat)
- Empty results
"""

from __future__ import annotations

from unittest.mock import MagicMock


from arforge.multiagent.merger import ResultMerger
from arforge.multiagent.protocol import Conversation, Task, TaskResult


class TestSingleResult:
    def test_success(self):
        merger = ResultMerger()
        result = TaskResult(task_id="t1", role="R", success=True, output="Hello")
        out = merger._single_result(result)
        assert out["answer"] == "Hello"
        assert out["strategy"] == "single"

    def test_failure(self):
        merger = ResultMerger()
        result = TaskResult(task_id="t1", role="R", success=False, error="Bad error")
        out = merger._single_result(result)
        assert "Bad error" in out["answer"]


class TestPipelineMerge:
    def test_pipeline_order(self):
        merger = ResultMerger()
        conv = Conversation(
            master_goal="Pipeline",
            tasks=[
                Task(task_id="t1", role="SearcherAgent", goal="S1"),
                Task(task_id="t2", role="CoderAgent", goal="S2", depends_on=["t1"]),
                Task(task_id="t3", role="TesterAgent", goal="S3", depends_on=["t2"]),
            ],
            results=[
                TaskResult(task_id="t1", role="SearcherAgent", success=True, output="Found file"),
                TaskResult(task_id="t2", role="CoderAgent", success=True, output="Fixed code"),
                TaskResult(task_id="t3", role="TesterAgent", success=True, output="Tests pass"),
            ],
        )
        out = merger._pipeline_merge(conv, "test")
        assert "Found file" in out["answer"]
        assert "Fixed code" in out["answer"]
        assert "Tests pass" in out["answer"]

    def test_pipeline_with_failure(self):
        merger = ResultMerger()
        conv = Conversation(
            master_goal="Pipeline",
            tasks=[
                Task(task_id="t1", role="SearcherAgent", goal="S1"),
                Task(task_id="t2", role="CoderAgent", goal="S2", depends_on=["t1"]),
            ],
            results=[
                TaskResult(task_id="t1", role="SearcherAgent", success=True, output="Found"),
                TaskResult(task_id="t2", role="CoderAgent", success=False, error="Compile error"),
            ],
        )
        out = merger._pipeline_merge(conv, "test")
        # Last success is t1's "Found"
        assert "Found" in out["answer"]


class TestAdversarialMerge:
    def test_coder_reviewer_tester(self):
        merger = ResultMerger()
        conv = Conversation(
            master_goal="Adversarial",
            tasks=[
                Task(task_id="t1", role="CoderAgent", goal="Code"),
                Task(task_id="t2", role="ReviewerAgent", goal="Review", depends_on=["t1"]),
                Task(task_id="t3", role="TesterAgent", goal="Test", depends_on=["t2"]),
            ],
            results=[
                TaskResult(task_id="t1", role="CoderAgent", success=True, output="def foo(): pass"),
                TaskResult(task_id="t2", role="ReviewerAgent", success=True, output="No issues found"),
                TaskResult(task_id="t3", role="TesterAgent", success=True, output="All tests pass"),
            ],
        )
        out = merger._adversarial_merge(conv, "Implement foo")
        assert "def foo" in out["answer"]
        assert "No issues" in out["answer"]
        assert "All tests" in out["answer"]
        assert out["strategy"] == "adversarial"

    def test_reviewer_found_issues(self):
        merger = ResultMerger()
        conv = Conversation(
            master_goal="Adversarial fail",
            tasks=[
                Task(task_id="t1", role="CoderAgent", goal="Code"),
                Task(task_id="t2", role="ReviewerAgent", goal="Review", depends_on=["t1"]),
            ],
            results=[
                TaskResult(task_id="t1", role="CoderAgent", success=True, output="bad code"),
                TaskResult(task_id="t2", role="ReviewerAgent", success=True, output="Security issue found!"),
            ],
        )
        out = merger._adversarial_merge(conv, "Code review")
        assert "Security issue" in out["answer"]


class TestLLMSynthesis:
    def test_llm_available(self):
        """When master has an agent, use LLM synthesis."""
        mock_agent = MagicMock()
        mock_agent.adapter.generate.return_value = "Synthesized answer"
        master = MagicMock()
        master.agent = mock_agent
        merger = ResultMerger(master=master)

        conv = Conversation(
            master_goal="Test",
            tasks=[
                Task(task_id="t1", role="A", goal="X"),
                Task(task_id="t2", role="B", goal="Y"),
            ],
            results=[
                TaskResult(task_id="t1", role="A", success=True, output="Result A"),
                TaskResult(task_id="t2", role="B", success=True, output="Result B"),
            ],
        )
        out = merger._llm_synthesis(conv, "test")
        assert out["answer"] == "Synthesized answer"
        assert out["strategy"] == "llm_synthesis"

    def test_fallback_concat(self):
        """When no master/agent, concatenate results."""
        merger = ResultMerger(master=None)
        conv = Conversation(
            master_goal="Test",
            results=[
                TaskResult(task_id="t1", role="A", success=True, output="R1"),
                TaskResult(task_id="t2", role="B", success=True, output="R2"),
            ],
        )
        out = merger._llm_synthesis(conv, "test")
        assert "R1" in out["answer"]
        assert "R2" in out["answer"]
        assert out["strategy"] == "concat_fallback"


class TestMergeMain:
    def test_single_result_path(self):
        merger = ResultMerger()
        conv = Conversation(
            master_goal="Single",
            results=[TaskResult(task_id="t1", role="R", success=True, output="Done")],
        )
        out = merger.merge(conv, "Single task")
        assert out["strategy"] == "single"
        assert out["answer"] == "Done"

    def test_empty_results(self):
        merger = ResultMerger()
        conv = Conversation(master_goal="Empty")
        out = merger.merge(conv, "Nothing")
        assert out["strategy"] == "empty"
        assert out["answer"] == ""


class TestDetection:
    def test_is_pipeline_true(self):
        conv = Conversation(
            master_goal="P",
            tasks=[
                Task(task_id="t1", role="A", goal="S1"),
                Task(task_id="t2", role="B", goal="S2", depends_on=["t1"]),
                Task(task_id="t3", role="C", goal="S3", depends_on=["t2"]),
            ],
        )
        assert ResultMerger._is_pipeline(conv) is True

    def test_is_pipeline_false_for_independent(self):
        conv = Conversation(
            master_goal="I",
            tasks=[
                Task(task_id="t1", role="A", goal="S1"),
                Task(task_id="t2", role="B", goal="S2"),
            ],
        )
        assert ResultMerger._is_pipeline(conv) is False

    def test_is_adversarial_true(self):
        conv = Conversation(
            master_goal="A",
            results=[
                TaskResult(task_id="t1", role="CoderAgent", success=True, output="x"),
                TaskResult(task_id="t2", role="ReviewerAgent", success=True, output="y"),
            ],
        )
        assert ResultMerger._is_adversarial(conv) is True

    def test_is_adversarial_false(self):
        conv = Conversation(
            master_goal="S",
            results=[TaskResult(task_id="t1", role="SearcherAgent", success=True, output="x")],
        )
        assert ResultMerger._is_adversarial(conv) is False
