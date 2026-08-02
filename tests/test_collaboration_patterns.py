"""Test B8: 4 collaboration patterns — Pipeline, Fanout, Adversarial, Iterative.

Verifies:
- Pipeline creates sequential dependency chain
- Fanout creates independent parallel tasks
- Adversarial creates Coder→Reviewer→Coder→Tester chain
- Iterative creates initial tasks with shared_memory metadata
"""

from __future__ import annotations

from arforge.multiagent.patterns import adversarial, fanout, iterative, pipeline
from arforge.multiagent.protocol import Conversation


class TestPipelinePattern:
    def test_creates_sequential_chain(self):
        conv = pipeline(
            roles=["SearcherAgent", "CoderAgent", "TesterAgent"],
            goal="Fix bug and test",
        )
        assert isinstance(conv, Conversation)
        assert len(conv.tasks) == 3

        # Task 0: no deps
        assert conv.tasks[0].depends_on == []
        # Task 1: depends on task 0
        assert conv.tasks[1].depends_on == ["pipe_0"]
        # Task 2: depends on task 1
        assert conv.tasks[2].depends_on == ["pipe_1"]

    def test_roles_assigned_correctly(self):
        conv = pipeline(
            roles=["SearcherAgent", "CoderAgent"],
            goal="Search and fix",
        )
        assert conv.tasks[0].role == "SearcherAgent"
        assert conv.tasks[1].role == "CoderAgent"

    def test_goal_propagated(self):
        conv = pipeline(roles=["A", "B"], goal="Shared goal")
        for t in conv.tasks:
            assert t.goal == "Shared goal"

    def test_role_goals_override(self):
        conv = pipeline(
            roles=["A", "B"],
            goal="Default",
            role_goals=["Search files", "Fix bug"],
        )
        assert conv.tasks[0].goal == "Search files"
        assert conv.tasks[1].goal == "Fix bug"

    def test_priority_decreasing(self):
        conv = pipeline(roles=["A", "B", "C"], goal="Test")
        assert conv.tasks[0].priority == 100
        assert conv.tasks[1].priority == 99
        assert conv.tasks[2].priority == 98


class TestFanoutPattern:
    def test_creates_independent_tasks(self):
        conv = fanout(
            roles=["SearcherAgent", "DocAgent", "DataAgent"],
            goal="Analyze project",
        )
        assert len(conv.tasks) == 3
        for t in conv.tasks:
            assert t.depends_on == [], "Fanout tasks should be independent"

    def test_roles_assigned(self):
        conv = fanout(roles=["A", "B"], goal="G")
        assert conv.tasks[0].role == "A"
        assert conv.tasks[1].role == "B"

    def test_role_goals_override(self):
        conv = fanout(
            roles=["CoderAgent", "ReviewerAgent"],
            goal="Default",
            role_goals=["Write code", "Review architecture"],
        )
        assert conv.tasks[0].goal == "Write code"
        assert conv.tasks[1].goal == "Review architecture"

    def test_conversation_id_prefix(self):
        conv = fanout(roles=["A"], goal="G")
        assert conv.conversation_id.startswith("fanout_")


class TestAdversarialPattern:
    def test_four_step_chain(self):
        conv = adversarial(goal="Implement login")
        assert len(conv.tasks) == 4

    def test_correct_roles_in_order(self):
        conv = adversarial(goal="Fix bug")
        assert conv.tasks[0].role == "CoderAgent"
        assert conv.tasks[1].role == "ReviewerAgent"
        assert conv.tasks[2].role == "CoderAgent"  # Fix after review
        assert conv.tasks[3].role == "TesterAgent"

    def test_dependency_chain(self):
        conv = adversarial(goal="Implement feature")
        assert conv.tasks[0].depends_on == []
        assert conv.tasks[1].depends_on == ["adv_code"]
        assert conv.tasks[2].depends_on == ["adv_review"]
        assert conv.tasks[3].depends_on == ["adv_fix"]

    def test_custom_roles(self):
        conv = adversarial(
            coder_role="MyCoder",
            reviewer_role="MyReviewer",
            tester_role="MyTester",
            goal="Custom",
        )
        assert conv.tasks[0].role == "MyCoder"
        assert conv.tasks[1].role == "MyReviewer"
        assert conv.tasks[3].role == "MyTester"


class TestIterativePattern:
    def test_creates_initial_tasks(self):
        conv = iterative(goal="Refactor module")
        assert len(conv.tasks) > 0

    def test_stores_metadata_in_shared_memory(self):
        conv = iterative(goal="Optimize", max_iterations=5)
        assert conv.shared_memory["pattern"] == "iterative"
        assert conv.shared_memory["max_iterations"] == 5
        assert conv.shared_memory["current_iteration"] == 0

    def test_default_roles(self):
        conv = iterative(goal="Analyze")
        roles = {t.role for t in conv.tasks}
        assert "SearcherAgent" in roles
        assert "CoderAgent" in roles
        assert "ReviewerAgent" in roles

    def test_custom_roles(self):
        conv = iterative(goal="Task", roles=["PlannerAgent", "CoderAgent"])
        assert len(conv.tasks) == 2
        assert conv.tasks[0].role == "PlannerAgent"
        assert conv.tasks[1].role == "CoderAgent"

    def test_conversation_id_prefix(self):
        conv = iterative(goal="G")
        assert conv.conversation_id.startswith("iterative_")
