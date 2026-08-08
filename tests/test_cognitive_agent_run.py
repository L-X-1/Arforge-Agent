"""Governed lifecycle and AgentRun cognitive persistence integration."""

from __future__ import annotations

import pytest


def test_governed_lifecycle_covers_understanding_learning_and_completion():
    from arforge.core.agent_run import AgentRun, RunState

    run = AgentRun(run_id="run-lifecycle", governed_lifecycle=True)
    run.enable_cognitive_runtime("Repair cache", task_id="task-lifecycle")

    for state in (
        RunState.UNDERSTANDING,
        RunState.PLANNING,
        RunState.EXECUTING,
        RunState.VERIFYING,
        RunState.LEARNING,
        RunState.COMPLETED,
    ):
        run.transition(state, f"enter {state.value}")

    assert run.state is RunState.COMPLETED
    assert run.cognitive_task is not None
    assert run.cognitive_task.state.value == "completed"
    assert [event.event_type for event in run.cognitive_events] == [
        "task.created",
        "state.transitioned",
        "state.transitioned",
        "state.transitioned",
        "state.transitioned",
        "state.transitioned",
        "state.transitioned",
    ]


def test_governed_lifecycle_supports_block_and_replanning():
    from arforge.core.agent_run import AgentRun, RunState

    run = AgentRun(governed_lifecycle=True)
    run.enable_cognitive_runtime("Repair cache", task_id="task-blocked")
    run.transition(RunState.UNDERSTANDING, "start")
    run.transition(RunState.BLOCKED, "missing reproduction")
    run.transition(RunState.PLANNING, "reproduction supplied")

    assert run.state is RunState.PLANNING
    assert run.cognitive_task.state.value == "planning"


def test_governed_lifecycle_rejects_unverified_completion_without_event():
    from arforge.core.agent_run import AgentRun, RunState

    run = AgentRun(governed_lifecycle=True)
    run.enable_cognitive_runtime("Repair cache", task_id="task-no-skip")
    run.transition(RunState.UNDERSTANDING, "start")
    run.transition(RunState.PLANNING, "plan")
    run.transition(RunState.EXECUTING, "execute")
    before = tuple(run.cognitive_events)

    with pytest.raises(ValueError, match="executing -> completed"):
        run.transition(RunState.COMPLETED, "model says done")

    assert run.state is RunState.EXECUTING
    assert tuple(run.cognitive_events) == before


def test_rollback_success_and_failure_have_distinct_states():
    from arforge.core.agent_run import AgentRun, RunState

    successful = AgentRun(governed_lifecycle=True)
    successful.enable_cognitive_runtime("Repair cache", task_id="task-rollback")
    successful.transition(RunState.UNDERSTANDING, "start")
    successful.transition(RunState.FAILED, "write failed")
    successful.transition(RunState.ROLLING_BACK, "restore")
    successful.transition(RunState.ROLLED_BACK, "restored snapshot")
    assert successful.state is RunState.ROLLED_BACK
    assert successful.is_terminal()

    failed = AgentRun(governed_lifecycle=True)
    failed.enable_cognitive_runtime("Repair cache", task_id="task-rollback-failed")
    failed.transition(RunState.UNDERSTANDING, "start")
    failed.transition(RunState.FAILED, "write failed")
    failed.transition(RunState.ROLLING_BACK, "restore")
    failed.transition(RunState.FAILED, "rollback failed")
    assert failed.state is RunState.FAILED


def test_existing_compatibility_transition_path_remains_valid():
    from arforge.core.agent_run import AgentRun, RunState

    run = AgentRun()
    run.transition(RunState.PLANNING, "legacy")
    run.transition(RunState.EXECUTING, "legacy")
    run.transition(RunState.COMPLETED, "legacy")

    assert run.state is RunState.COMPLETED
    assert run.cognitive_task is None


def test_run_state_values_are_all_supported_by_agent_ir():
    from arforge.core.agent_run import RunState
    from arforge.core.cognitive_ir import LifecycleState

    assert {state.value for state in RunState} <= {state.value for state in LifecycleState}


def test_callback_failure_does_not_erase_durable_transition(tmp_path):
    from arforge.core.agent_run import AgentRun, RunState
    from arforge.core.run_event_journal import RunEventJournal

    run = AgentRun(
        run_id="run-callback",
        governed_lifecycle=True,
        cognitive_persistence_root=tmp_path,
    )
    run.enable_cognitive_runtime("Repair cache", task_id="task-callback")
    run._on_state_change = lambda *_args: (_ for _ in ()).throw(RuntimeError("observer failed"))

    run.transition(RunState.UNDERSTANDING, "start")

    journal = RunEventJournal(
        tmp_path / "run-callback" / "events.jsonl",
        run_id="run-callback",
    )
    events = journal.read_verified()
    assert events[-1].event_type == "state.transitioned"
    assert events[-1].payload["to"] == "understanding"
    assert run.state is RunState.UNDERSTANDING


def test_stubbed_agent_run_persists_checkpoint_and_replays_after_restart(tmp_path, monkeypatch):
    from arforge.core import agent_loop_v2, agent_run
    from arforge.core.agent_run import AgentRun, RunState
    from arforge.core.agentic import ToolLoopResult

    class StubLoop:
        def __init__(self, agent):
            self.agent = agent

        def run_agentic(self, **_kwargs):
            return ToolLoopResult(
                answer="done",
                messages=[{"role": "user", "content": "Repair cache"}],
                steps=2,
                verifications=[
                    {
                        "tool": "run_tests",
                        "criterion": "Target tests pass",
                        "passed": True,
                        "step": 2,
                    }
                ],
            )

    monkeypatch.setattr(agent_loop_v2, "AgentLoopV2", StubLoop)
    monkeypatch.setattr(agent_run, "install_compaction_hook", lambda: None)
    monkeypatch.setattr(agent_run, "install_run_report_hook", lambda: None)
    monkeypatch.setattr(agent_run, "get_run_transaction", lambda: object())
    monkeypatch.setattr(agent_run, "persist_run_transaction", lambda _run_id: None)
    monkeypatch.setattr(agent_run, "save_run_messages", lambda _run_id, _messages: None)
    monkeypatch.setattr(agent_run, "get_run_report", lambda: None)

    original = AgentRun(
        run_id="run-restart",
        agent=object(),
        user_input="Repair cache",
        governed_lifecycle=True,
        cognitive_persistence_root=tmp_path,
    )
    result = original.execute()

    assert result.state is RunState.COMPLETED
    assert result.structured_checkpoint is not None
    assert result.cognitive_state is not None
    assert any(record["kind"] == "verification" for record in result.cognitive_state["records"])

    restored = AgentRun(
        run_id="run-restart",
        governed_lifecycle=True,
        cognitive_persistence_root=tmp_path,
    )
    restored.restore_cognitive_runtime()

    assert restored.state is RunState.COMPLETED
    assert restored.cognitive_task == original.cognitive_task
    assert restored.cognitive_task.to_dict() == result.cognitive_state


def test_workspace_cognitive_root_is_stable_scoped_and_path_private(tmp_path):
    from arforge.core.cognitive_paths import workspace_cognitive_root

    data_root = tmp_path / "profile"
    first = workspace_cognitive_root(tmp_path / "workspace-a", data_root=data_root)
    repeated = workspace_cognitive_root(tmp_path / "workspace-a", data_root=data_root)
    other = workspace_cognitive_root(tmp_path / "workspace-b", data_root=data_root)

    assert first == repeated
    assert first != other
    assert first.parent == data_root / "cognitive-runs" / "workspaces"
    assert len(first.name) == 24
    assert all(character in "0123456789abcdef" for character in first.name)
    assert "workspace-a" not in str(first)


def test_coordinator_enables_governed_workspace_persistence_for_single_runs(tmp_path, monkeypatch):
    from arforge.core import coordinator as coordinator_module
    from arforge.core.agent_run import RunResult, RunState
    from arforge.core.coordinator import CoordinatorAgent

    captured = {}

    class StubRun:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def execute(self):
            return RunResult(run_id="run-coordinator", state=RunState.COMPLETED)

    monkeypatch.setattr(coordinator_module, "AgentRun", StubRun)
    coordinator = CoordinatorAgent(
        force_single=True,
        cognitive_persistence_root=tmp_path / "cognitive",
    )

    result = coordinator._execute_single("Repair cache")

    assert result.state is RunState.COMPLETED
    assert captured["governed_lifecycle"] is True
    assert captured["cognitive_persistence_root"] == tmp_path / "cognitive"


def test_execute_reports_successful_rollback_as_rolled_back(monkeypatch):
    from arforge.core import agent_loop_v2, agent_run
    from arforge.core.agent_run import AgentRun, RunState

    class FailingLoop:
        def __init__(self, agent):
            self.agent = agent

        def run_agentic(self, **_kwargs):
            raise RuntimeError("tool failed")

    monkeypatch.setattr(agent_loop_v2, "AgentLoopV2", FailingLoop)
    monkeypatch.setattr(agent_run, "install_compaction_hook", lambda: None)
    monkeypatch.setattr(agent_run, "install_run_report_hook", lambda: None)
    monkeypatch.setattr(agent_run, "get_run_transaction", lambda: object())
    monkeypatch.setattr(agent_run, "revert_run", lambda _run_id: ([], [], []))

    result = AgentRun(
        run_id="run-error-rollback",
        agent=object(),
        user_input="Repair cache",
        governed_lifecycle=True,
    ).execute()

    assert result.state is RunState.ROLLED_BACK
    assert result.error == "tool failed"
    assert result.rollback_events[-1]["success"] is True
    assert result.cognitive_state["state"] == "rolled_back"
    rollback_event = next(
        event for event in result.cognitive_events if event["event_type"] == "rollback.recorded"
    )
    assert rollback_event["payload"] == {
        "source_state": "failed",
        "restored_point": "run:run-error-rollback",
        "status": "succeeded",
    }


def test_execute_preserves_failed_state_when_rollback_fails(monkeypatch):
    from arforge.core import agent_loop_v2, agent_run
    from arforge.core.agent_run import AgentRun, RunState

    class FailingLoop:
        def __init__(self, agent):
            self.agent = agent

        def run_agentic(self, **_kwargs):
            raise RuntimeError("tool failed")

    monkeypatch.setattr(agent_loop_v2, "AgentLoopV2", FailingLoop)
    monkeypatch.setattr(agent_run, "install_compaction_hook", lambda: None)
    monkeypatch.setattr(agent_run, "install_run_report_hook", lambda: None)
    monkeypatch.setattr(agent_run, "get_run_transaction", lambda: object())
    monkeypatch.setattr(
        agent_run,
        "revert_run",
        lambda _run_id: (_ for _ in ()).throw(RuntimeError("restore failed")),
    )

    result = AgentRun(
        run_id="run-error-failed",
        agent=object(),
        user_input="Repair cache",
        governed_lifecycle=True,
    ).execute()

    assert result.state is RunState.FAILED
    assert result.error == "tool failed"
    assert result.rollback_events[-1]["success"] is False
    assert result.rollback_events[-1]["error"] == "restore failed"
    assert result.cognitive_state["state"] == "failed"
    rollback_event = next(
        event for event in result.cognitive_events if event["event_type"] == "rollback.recorded"
    )
    assert rollback_event["payload"]["source_state"] == "failed"
    assert rollback_event["payload"]["status"] == "failed"
    assert rollback_event["payload"]["error"] == "restore failed"


def test_explicit_failed_verification_cannot_be_reported_as_completed(tmp_path, monkeypatch):
    from arforge.core import agent_loop_v2, agent_run
    from arforge.core.agent_run import AgentRun, RunState
    from arforge.core.agentic import ToolLoopResult

    class FailedVerificationLoop:
        def __init__(self, agent):
            self.agent = agent

        def run_agentic(self, **_kwargs):
            return ToolLoopResult(
                answer="patch written",
                messages=[],
                steps=1,
                verifications=[
                    {
                        "tool": "run_tests",
                        "criterion": "Target tests pass",
                        "passed": False,
                        "step": 1,
                    }
                ],
                incomplete_report=None,
            )

    monkeypatch.setattr(agent_loop_v2, "AgentLoopV2", FailedVerificationLoop)
    monkeypatch.setattr(agent_run, "install_compaction_hook", lambda: None)
    monkeypatch.setattr(agent_run, "install_run_report_hook", lambda: None)
    monkeypatch.setattr(agent_run, "get_run_transaction", lambda: object())
    monkeypatch.setattr(agent_run, "persist_run_transaction", lambda _run_id: None)
    monkeypatch.setattr(agent_run, "save_run_messages", lambda _run_id, _messages: None)
    monkeypatch.setattr(agent_run, "get_run_report", lambda: None)

    result = AgentRun(
        run_id="run-verification-failed",
        agent=object(),
        user_input="Repair cache",
        governed_lifecycle=True,
        cognitive_persistence_root=tmp_path,
    ).execute()

    assert result.state is RunState.INCOMPLETE
    assert result.incomplete_report == {
        "stop_reason": "verification_failed",
        "remaining": ["Target tests pass"],
    }
    assert result.error == "Agent loop stopped before completion: verification_failed"
    assert result.cognitive_state["state"] == "incomplete"
