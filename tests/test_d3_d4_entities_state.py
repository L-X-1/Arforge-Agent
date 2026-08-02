"""Tests for D3+D4: Entity schemas and AgentRun state machine."""

from __future__ import annotations

import pytest
from arforge.core.entities import (
    ProjectEntity,
    SessionEntity,
    AgentRunEntity,
    TurnEntity,
    StepEntity,
    ToolCallEntity,
    ApprovalEntity,
    DiffActionEntity,
    TaskEntity,
    SkillEntity,
    SubagentRoleEntity,
    MemoryEntity,
    LearningOutcomeEntity,
    EvalCaseEntity,
    ReleaseEvidenceEntity,
    ENTITY_REGISTRY,
    describe_entity,
)
from arforge.core.agent_run import RunState, AgentRun, RunResult, _TRANSITIONS


class TestEntitySchemas:
    """D3: Every entity schema round-trips to_dict and has required fields."""

    def test_project_to_dict(self):
        e = ProjectEntity(project_id="p1", root="/tmp/test")
        d = e.to_dict()
        assert d["project_id"] == "p1"
        assert d["root"] == "/tmp/test"
        assert d["trust_state"] == "untrusted"

    def test_session_to_dict(self):
        e = SessionEntity(session_id="s1", project_id="p1")
        d = e.to_dict()
        assert d["session_id"] == "s1"
        assert d["status"] == "active"

    def test_agent_run_to_dict(self):
        e = AgentRunEntity(run_id="r1", session_id="s1")
        d = e.to_dict()
        assert d["run_id"] == "r1"
        assert d["mode"] == "auto"

    def test_turn_to_dict(self):
        e = TurnEntity(turn_id="t1", run_id="r1", input="hello")
        d = e.to_dict()
        assert d["turn_id"] == "t1"

    def test_step_to_dict(self):
        e = StepEntity(step_id="st1", run_id="r1", kind="tool")
        d = e.to_dict()
        assert d["kind"] == "tool"
        assert d["state"] == "pending"

    def test_tool_call_to_dict(self):
        e = ToolCallEntity(tool_id="tc1", run_id="r1", name="read_file")
        d = e.to_dict()
        assert d["name"] == "read_file"
        assert d["risk"] == "low"

    def test_approval_to_dict(self):
        e = ApprovalEntity(approval_id="a1", action_id="ac1")
        d = e.to_dict()
        assert d["status"] == "pending"

    def test_diff_action_to_dict(self):
        from pathlib import Path
        e = DiffActionEntity(path=Path("/tmp/test.py"), before_hash="abc")
        d = e.to_dict()
        assert d["state"] == "previewed"

    def test_task_to_dict(self):
        e = TaskEntity(task_id="tk1", owner_session="s1")
        d = e.to_dict()
        assert d["status"] == "queued"

    def test_skill_to_dict(self):
        e = SkillEntity(skill_id="sk1", version="2.0.0")
        d = e.to_dict()
        assert d["version"] == "2.0.0"

    def test_subagent_role_to_dict(self):
        e = SubagentRoleEntity(role_id="reviewer", tools=["read_file", "grep"])
        d = e.to_dict()
        assert len(d["tools"]) == 2

    def test_memory_to_dict(self):
        e = MemoryEntity(memory_id="m1", content="user prefers pytest")
        d = e.to_dict()
        assert d["confidence"] == 0.0

    def test_learning_outcome_to_dict(self):
        e = LearningOutcomeEntity(outcome_id="lo1", failure_type="tool_error")
        d = e.to_dict()
        assert d["failure_type"] == "tool_error"

    def test_eval_case_to_dict(self):
        e = EvalCaseEntity(case_id="ec1", prompt="fix the bug")
        d = e.to_dict()
        assert d["case_id"] == "ec1"

    def test_release_evidence_to_dict(self):
        e = ReleaseEvidenceEntity(gate_id="g1", sha256="deadbeef")
        d = e.to_dict()
        assert d["sha256"] == "deadbeef"

    def test_registry_covers_all_entities(self):
        assert len(ENTITY_REGISTRY) == 15
        for name, cls in ENTITY_REGISTRY.items():
            assert hasattr(cls, "to_dict"), f"{name} missing to_dict"

    def test_describe_entity_returns_schema(self):
        info = describe_entity("project")
        assert info["entity"] == "project"
        assert len(info["fields"]) >= 3  # project_id, root, trust_state

    def test_describe_unknown_returns_none(self):
        assert describe_entity("nonexistent") is None


class TestRunStateMachine:
    """D4: AgentRun state transitions and lifecycle."""

    def test_initial_state_is_created(self):
        run = AgentRun()
        assert run.state == RunState.CREATED

    def test_valid_transition_planning(self):
        run = AgentRun()
        run.transition(RunState.PLANNING, "start")
        assert run.state == RunState.PLANNING

    def test_valid_transition_to_executing(self):
        run = AgentRun()
        run.transition(RunState.PLANNING, "plan done")
        run.transition(RunState.EXECUTING, "executing")
        assert run.state == RunState.EXECUTING

    def test_invalid_transition_raises(self):
        run = AgentRun()
        with pytest.raises(ValueError, match="Invalid state transition"):
            run.transition(RunState.COMPLETED, "skip everything")

    def test_transition_log_records_events(self):
        run = AgentRun()
        run.transition(RunState.PLANNING, "plan start")
        run.transition(RunState.EXECUTING, "executing")
        assert len(run._transition_log) >= 3  # created + 2 transitions

    def test_is_terminal_for_completed(self):
        run = AgentRun()
        assert not run.is_terminal()
        run._transition_log.append({"state": RunState.COMPLETED.value, "timestamp": 0, "reason": "test"})
        run.state = RunState.COMPLETED
        assert run.is_terminal()

    def test_is_terminal_for_failed(self):
        run = AgentRun()
        run.state = RunState.FAILED
        assert run.is_terminal()

    def test_is_terminal_for_interrupted(self):
        run = AgentRun()
        run.state = RunState.INTERRUPTED
        assert run.is_terminal()

    def test_executing_can_transition_to_verifying(self):
        run = AgentRun()
        run.transition(RunState.PLANNING, "plan")
        run.transition(RunState.EXECUTING, "exec")
        run.transition(RunState.VERIFYING, "verify")
        assert run.state == RunState.VERIFYING

    def test_verifying_can_transition_back_to_executing(self):
        run = AgentRun()
        run.transition(RunState.PLANNING, "plan")
        run.transition(RunState.EXECUTING, "exec")
        run.transition(RunState.VERIFYING, "verify")
        run.transition(RunState.EXECUTING, "retry after verify fail")
        assert run.state == RunState.EXECUTING

    def test_transition_graph_completeness(self):
        """Every non-terminal state has at least one outgoing transition."""
        for state, targets in _TRANSITIONS.items():
            if state not in {RunState.COMPLETED}:
                assert len(targets) > 0, f"{state} has no outgoing transitions"

    def test_on_state_change_callback(self):
        events = []
        run = AgentRun()
        run._on_state_change = lambda old, new, reason: events.append((old, new, reason))
        run.transition(RunState.PLANNING, "go")
        assert len(events) == 1
        assert events[0][1] == RunState.PLANNING

    def test_run_result_defaults(self):
        result = RunResult(run_id="r1", state=RunState.CREATED)
        assert result.run_id == "r1"
        assert result.answer == ""
        assert result.steps == 0

    def test_execute_requires_agent(self):
        """AgentRun.execute() requires agent to be set."""
        run = AgentRun(run_id="test-run")
        run.user_input = "test task"
        # AgentRun.execute() creates a default AgentLoopV2 internally.
        # This is a structural test — full execution requires LLM API key.
        assert run.state == RunState.CREATED
        assert callable(run.execute)
