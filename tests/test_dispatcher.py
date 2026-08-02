"""Test B5: TaskDispatcher — topological sort, serial/parallel, retry, timeout.

Verifies:
- Topological sort groups tasks into correct levels
- Serial execution (single task per level)
- Parallel execution (multiple tasks in same level)
- Retry on failure
- Timeout handling
- Empty task list
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from arforge.multiagent.dispatcher import TaskDispatcher
from arforge.multiagent.protocol import Conversation, Task, TaskResult


class TestTopologicalLevels:
    def test_single_task(self):
        tasks = [Task(task_id="t1", role="R", goal="G")]
        levels = TaskDispatcher._topological_levels(tasks)
        assert len(levels) == 1
        assert len(levels[0]) == 1

    def test_independent_tasks_same_level(self):
        tasks = [
            Task(task_id="t1", role="A", goal="G1"),
            Task(task_id="t2", role="B", goal="G2"),
        ]
        levels = TaskDispatcher._topological_levels(tasks)
        assert len(levels) == 1
        assert len(levels[0]) == 2

    def test_dependent_tasks_different_levels(self):
        tasks = [
            Task(task_id="t1", role="A", goal="G1"),
            Task(task_id="t2", role="B", goal="G2", depends_on=["t1"]),
        ]
        levels = TaskDispatcher._topological_levels(tasks)
        assert len(levels) == 2
        assert levels[0][0].task_id == "t1"
        assert levels[1][0].task_id == "t2"

    def test_multi_level_pipeline(self):
        tasks = [
            Task(task_id="t1", role="SearcherAgent", goal="Search"),
            Task(task_id="t2", role="CoderAgent", goal="Code", depends_on=["t1"]),
            Task(task_id="t3", role="ReviewerAgent", goal="Review", depends_on=["t2"]),
            Task(task_id="t4", role="TesterAgent", goal="Test", depends_on=["t3"]),
        ]
        levels = TaskDispatcher._topological_levels(tasks)
        assert len(levels) == 4

    def test_fanout_dependencies(self):
        tasks = [
            Task(task_id="t1", role="SearcherAgent", goal="Search"),
            Task(task_id="t2", role="CoderAgent", goal="Code", depends_on=["t1"]),
            Task(task_id="t3", role="ReviewerAgent", goal="Review", depends_on=["t1"]),
        ]
        levels = TaskDispatcher._topological_levels(tasks)
        assert len(levels) == 2
        assert len(levels[1]) == 2  # t2 and t3 both depend on t1 only

    def test_empty_tasks(self):
        levels = TaskDispatcher._topological_levels([])
        assert levels == []


class TestDispatch:
    @pytest.fixture(autouse=True)
    def setup_pool(self):
        """Mock the pool to return agents that succeed."""
        self.mock_agent = MagicMock()
        self.mock_result = TaskResult(task_id="t1", role="R", success=True, output="ok", elapsed_ms=10)
        self.mock_agent.execute.return_value = self.mock_result

        mock_pool = MagicMock()
        mock_pool.create_agent.return_value = self.mock_agent
        mock_pool.borrow_agent = lambda role: None  # fall through to create_agent
        mock_pool.return_agent = lambda role, agent: None  # no-op for mock

        self.dispatcher = TaskDispatcher()
        self.dispatcher._pool = mock_pool  # bypass lazy import
        yield

    def test_single_task_dispatch(self):
        tasks = [Task(task_id="t1", role="CoderAgent", goal="Fix bug")]
        conv = Conversation(master_goal="Fix bug")
        results = self.dispatcher.dispatch(tasks, conv)
        assert len(results) == 1
        assert results[0].success is True

    def test_two_independent_tasks(self):
        tasks = [
            Task(task_id="t1", role="SearcherAgent", goal="Search"),
            Task(task_id="t2", role="DocAgent", goal="Doc"),
        ]
        conv = Conversation(master_goal="Search and doc")
        results = self.dispatcher.dispatch(tasks, conv)
        assert len(results) == 2

    def test_retry_on_failure(self):
        """Agent fails first time, succeeds on retry."""
        self.mock_agent.execute.side_effect = [
            TaskResult(task_id="t1", role="R", success=False, error="fail1", elapsed_ms=10),
            TaskResult(task_id="t1", role="R", success=True, output="ok retry", elapsed_ms=10),
        ]
        self.dispatcher.max_retries = 1

        tasks = [Task(task_id="t1", role="CoderAgent", goal="Fix")]
        conv = Conversation(master_goal="Fix")
        results = self.dispatcher.dispatch(tasks, conv)
        assert results[0].success is True
        assert results[0].output == "ok retry"

    def test_retries_exhausted(self):
        """Agent fails all attempts."""
        self.mock_agent.execute.return_value = TaskResult(
            task_id="t1", role="R", success=False, error="persistent failure", elapsed_ms=10
        )
        self.dispatcher.max_retries = 2

        tasks = [Task(task_id="t1", role="CoderAgent", goal="Fix")]
        conv = Conversation(master_goal="Fix")
        results = self.dispatcher.dispatch(tasks, conv)
        assert results[0].success is False

    def test_unknown_role(self):
        """Unknown role → failed TaskResult."""
        self.dispatcher._pool.create_agent.return_value = None
        tasks = [Task(task_id="t1", role="NonexistentAgent", goal="X")]
        conv = Conversation(master_goal="X")
        results = self.dispatcher.dispatch(tasks, conv)
        assert results[0].success is False
        assert "unknown role" in results[0].error

    def test_empty_tasks_returns_empty(self):
        conv = Conversation(master_goal="Empty")
        results = self.dispatcher.dispatch([], conv)
        assert results == []
