"""Tests for AgentRun state machine and multi-dimensional work budget (Phase 1)."""

import pytest
from arforge.core.agent_run import AgentRun, RunState
from arforge.core.budget import WorkBudget, WorkBudgetTracker, budget_exceeded
from arforge.core.agentic import ToolLoopResult


class TestWorkBudget:
    """WP-04: Multi-dimensional budget tracking."""

    def test_unlimited_budget(self):
        """Default budget (all zeros) means unlimited."""
        b = WorkBudget()
        assert b.max_tokens == 0
        assert b.max_steps == 0
        assert b.max_seconds == 0
        assert b.max_files == 0

    def test_to_dict(self):
        b = WorkBudget(max_tokens=100000, max_steps=30, max_seconds=600, max_files=20)
        d = b.to_dict()
        assert d["max_tokens"] == 100000
        assert d["max_steps"] == 30
        assert d["max_seconds"] == 600
        assert d["max_files"] == 20

    def test_from_complexity(self):
        simple = WorkBudget.from_complexity("simple")
        assert simple.max_steps == 10

        medium = WorkBudget.from_complexity("medium")
        assert medium.max_steps == 25

        complex_b = WorkBudget.from_complexity("complex")
        assert complex_b.max_steps == 40

        unknown = WorkBudget.from_complexity("unknown")
        assert unknown.max_tokens == 0  # unlimited fallback

    def test_tracker_no_budget_exceeded(self):
        """Unlimited budget should never exceed."""
        b = WorkBudget()
        t = WorkBudgetTracker(b)
        t.start()
        t.add_tokens(999999)
        t.add_step()
        assert t.check() is None
        assert not budget_exceeded(t)

    def test_tracker_token_exceeded(self):
        b = WorkBudget(max_tokens=100)
        t = WorkBudgetTracker(b)
        t.start()
        t.add_tokens(100)
        violation = t.check()
        assert violation is not None
        assert "token budget exceeded" in violation
        assert budget_exceeded(t)

    def test_tracker_step_exceeded(self):
        b = WorkBudget(max_steps=5)
        t = WorkBudgetTracker(b)
        t.start()
        for _ in range(5):
            t.add_step()
        violation = t.check()
        assert violation is not None
        assert "step budget exceeded" in violation

    def test_tracker_time_exceeded(self):
        b = WorkBudget(max_seconds=0.001)  # will exceed immediately
        t = WorkBudgetTracker(b)
        t.start()
        import time
        time.sleep(0.01)
        violation = t.check()
        assert violation is not None
        assert "time budget exceeded" in violation

    def test_tracker_files_exceeded(self):
        b = WorkBudget(max_files=3)
        t = WorkBudgetTracker(b)
        t.start()
        for _ in range(3):
            t.add_file_modification()
        violation = t.check()
        assert violation is not None
        assert "file modification budget exceeded" in violation

    def test_usage_pct(self):
        b = WorkBudget(max_tokens=100, max_steps=10)
        t = WorkBudgetTracker(b)
        t.start()
        t.add_tokens(50)
        t.add_step()
        pct = t.usage_pct()
        assert 0 < pct <= 100

    def test_snapshot(self):
        b = WorkBudget(max_tokens=1000, max_steps=20)
        t = WorkBudgetTracker(b)
        t.start()
        t.add_tokens(200)
        t.add_step()
        t.add_file_modification()
        snap = t.snapshot()
        assert snap["tokens_used"] == 200
        assert snap["steps_taken"] == 1
        assert snap["files_modified"] == 1
        assert "elapsed_seconds" in snap

    def test_log_event(self):
        b = WorkBudget()
        t = WorkBudgetTracker(b)
        t.start()
        t.log_event("test", {"key": "value"})
        assert len(t._events) == 1
        assert t._events[0]["event"] == "test"
        assert t._events[0]["detail"]["key"] == "value"


class TestAgentRunStateMachine:
    """WP-03: AgentRun state machine."""

    def test_initial_state(self):
        run = AgentRun()
        assert run.state == RunState.CREATED
        assert run.run_id
        assert len(run.run_id) == 12

    def test_valid_transitions(self):
        run = AgentRun()
        run.transition(RunState.PLANNING, "start planning")
        assert run.state == RunState.PLANNING
        assert len(run._transition_log) == 2  # created + planning

        run.transition(RunState.EXECUTING, "begin execution")
        assert run.state == RunState.EXECUTING

        run.transition(RunState.COMPLETED, "done")
        assert run.state == RunState.COMPLETED

    def test_invalid_transition_raises(self):
        run = AgentRun()
        with pytest.raises(ValueError, match="Invalid state transition"):
            run.transition(RunState.COMPLETED, "skip to end")

    def test_terminal_states(self):
        run = AgentRun()
        assert not run.is_terminal()

        run.transition(RunState.PLANNING, "")
        run.transition(RunState.EXECUTING, "")
        run.transition(RunState.FAILED, "error")
        assert run.is_terminal()
        assert run.state == RunState.FAILED

    def test_incomplete_is_a_terminal_state(self):
        run = AgentRun()
        run.transition(RunState.PLANNING, "")
        run.transition(RunState.EXECUTING, "")
        run.transition(RunState.VERIFYING, "")
        run.transition(RunState.INCOMPLETE, "step limit reached")
        assert run.is_terminal()
        assert run.state is RunState.INCOMPLETE

    def test_execute_preserves_verification_evidence(self, monkeypatch):
        from arforge.core import agent_loop_v2, agent_run

        class StubLoop:
            def __init__(self, agent):
                self.agent = agent

            def run_agentic(self, **_kwargs):
                return ToolLoopResult(
                    answer="done",
                    messages=[{"role": "user", "content": "task"}],
                    steps=2,
                    verifications=[{"tool": "run_tests", "passed": True, "step": 2}],
                )

        monkeypatch.setattr(agent_loop_v2, "AgentLoopV2", StubLoop)
        monkeypatch.setattr(agent_run, "install_compaction_hook", lambda: None)
        monkeypatch.setattr(agent_run, "install_run_report_hook", lambda: None)
        monkeypatch.setattr(agent_run, "get_run_transaction", lambda: object())
        monkeypatch.setattr(agent_run, "persist_run_transaction", lambda _run_id: None)
        monkeypatch.setattr(agent_run, "save_run_messages", lambda _run_id, _messages: None)
        monkeypatch.setattr(agent_run, "get_run_report", lambda: None)

        result = AgentRun(agent=object(), user_input="task").execute()

        assert result.state is RunState.COMPLETED
        assert result.error is None
        assert result.steps == 2
        assert result.verifications == [{"tool": "run_tests", "passed": True, "step": 2}]

    def test_execute_marks_step_limited_work_incomplete_without_rollback(self, monkeypatch):
        from arforge.core import agent_loop_v2, agent_run

        class StubLoop:
            def __init__(self, agent):
                self.agent = agent

            def run_agentic(self, **_kwargs):
                return ToolLoopResult(
                    answer="partial progress",
                    messages=[{"role": "user", "content": "task"}],
                    steps=10,
                    incomplete_report={"stop_reason": "max_steps", "steps_used": 10},
                )

        monkeypatch.setattr(agent_loop_v2, "AgentLoopV2", StubLoop)
        monkeypatch.setattr(agent_run, "install_compaction_hook", lambda: None)
        monkeypatch.setattr(agent_run, "install_run_report_hook", lambda: None)
        monkeypatch.setattr(agent_run, "get_run_transaction", lambda: object())
        monkeypatch.setattr(agent_run, "persist_run_transaction", lambda _run_id: None)
        monkeypatch.setattr(agent_run, "save_run_messages", lambda _run_id, _messages: None)
        monkeypatch.setattr(agent_run, "get_run_report", lambda: None)

        result = AgentRun(agent=object(), user_input="task").execute()

        assert result.state is RunState.INCOMPLETE
        assert "max_steps" in (result.error or "")
        assert result.steps == 10
        assert result.incomplete_report == {"stop_reason": "max_steps", "steps_used": 10}
        assert result.rollback_events == []

    def test_execute_starts_with_a_fresh_run_report(self, monkeypatch):
        from arforge.core import agent_loop_v2, agent_run
        from arforge.core.change_tracker import get_change_tracker, reset_change_tracker
        from arforge.core.run_report import get_run_report, reset_run_report

        class StubLoop:
            def __init__(self, agent):
                self.agent = agent

            def run_agentic(self, **_kwargs):
                return ToolLoopResult(answer="done", messages=[])

        reset_run_report()
        reset_change_tracker()
        get_run_report().record_tool(
            "read_file",
            {"filename": "stale-from-prior-run.py"},
            type("Result", (), {"success": True, "output": ""})(),
        )
        get_change_tracker().record("stale-from-prior-run.py")
        monkeypatch.setattr(agent_loop_v2, "AgentLoopV2", StubLoop)
        monkeypatch.setattr(agent_run, "install_compaction_hook", lambda: None)
        monkeypatch.setattr(agent_run, "install_run_report_hook", lambda: None)
        monkeypatch.setattr(agent_run, "get_run_transaction", lambda: object())
        monkeypatch.setattr(agent_run, "persist_run_transaction", lambda _run_id: None)
        monkeypatch.setattr(agent_run, "save_run_messages", lambda _run_id, _messages: None)

        result = AgentRun(agent=object(), user_input="task").execute()

        assert result.state is RunState.COMPLETED
        assert result.report is not None
        assert result.report["explored_files"] == []
        assert result.report["modified_files"] == []

    def test_transition_log(self):
        run = AgentRun()
        run.transition(RunState.PLANNING, "test transition")
        log = run._transition_log
        assert len(log) == 2
        # first entry uses "to" not "state" for initial creation`n        assert log[0].get("state") == "created" or log[0].get("to") == "created"
        assert log[1]["to"] == "planning"
        assert log[1]["reason"] == "test transition"

    def test_resume_creation(self):
        run = AgentRun.resume("abc123", messages=[])
        assert run.run_id == "abc123"
        assert run.resume_messages == []
        assert run.state == RunState.CREATED

    def test_state_change_callback(self):
        events = []

        def callback(old, new, reason):
            events.append((old, new, reason))

        run = AgentRun()
        run._on_state_change = callback
        run.transition(RunState.PLANNING, "test")
        assert len(events) == 1
        assert events[0][0] == RunState.CREATED
        assert events[0][1] == RunState.PLANNING


class TestFileStateTracker:
    """WP-06: File state tracking."""

    def test_read_and_cache(self, tmp_path):
        from arforge.core.file_state import FileStateTracker

        f = tmp_path / "test.txt"
        f.write_text("hello world", encoding="utf-8")

        tracker = FileStateTracker()
        content, is_stale = tracker.read(str(f))
        assert content == "hello world"
        assert not is_stale

    def test_re_read_no_change(self, tmp_path):
        from arforge.core.file_state import FileStateTracker

        f = tmp_path / "test.txt"
        f.write_text("hello world", encoding="utf-8")

        tracker = FileStateTracker()
        tracker.read(str(f))
        content, is_stale = tracker.read(str(f))
        assert content == "hello world"
        assert not is_stale  # unchanged

    def test_stale_detection(self, tmp_path):
        from arforge.core.file_state import FileStateTracker

        f = tmp_path / "test.txt"
        f.write_text("hello world", encoding="utf-8")

        tracker = FileStateTracker()
        tracker.read(str(f))

        # External modification
        f.write_text("modified content", encoding="utf-8")
        content, is_stale = tracker.read(str(f))
        assert content == "modified content"
        assert is_stale

    def test_invalidate(self, tmp_path):
        from arforge.core.file_state import FileStateTracker

        f = tmp_path / "test.txt"
        f.write_text("hello world", encoding="utf-8")

        tracker = FileStateTracker()
        tracker.read(str(f))
        tracker.invalidate(str(f))
        assert not tracker.is_stale(str(f))

    def test_get_stats(self, tmp_path):
        from arforge.core.file_state import FileStateTracker

        f1 = tmp_path / "a.txt"
        f2 = tmp_path / "b.txt"
        f1.write_text("aaa", encoding="utf-8")
        f2.write_text("bbb", encoding="utf-8")

        tracker = FileStateTracker()
        tracker.read(str(f1))
        tracker.read(str(f2))
        tracker.read(str(f1))  # re-read

        stats = tracker.get_stats()
        assert stats["files_tracked"] == 2
        assert stats["total_reads"] == 3
        assert stats["cache_hits"] == 1

    def test_nonexistent_file(self, tmp_path):
        from arforge.core.file_state import FileStateTracker

        tracker = FileStateTracker()
        content, is_stale = tracker.read(str(tmp_path / "nonexistent.txt"))
        assert content is None
        assert not is_stale

    def test_clear(self, tmp_path):
        from arforge.core.file_state import FileStateTracker

        f = tmp_path / "test.txt"
        f.write_text("hello", encoding="utf-8")

        tracker = FileStateTracker()
        tracker.read(str(f))
        assert tracker.get_stats()["files_tracked"] == 1

        tracker.clear()
        assert tracker.get_stats()["files_tracked"] == 0
