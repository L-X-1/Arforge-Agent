"""Integration tests for multi-agent Phase 2 enhancements.

Covers:
  - Thread-safe shared memory (concurrent writes)
  - Agent instance pooling (borrow/return/reuse)
  - Dynamic task routing (escalation to DebuggerAgent)
  - Cancellation tokens (cancel mid-dispatch)
  - Circuit breaker (consecutive failures trigger abort)
  - DispatchMetrics (collector accuracy, report formatting)
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace


from arforge.multiagent.dispatcher import DispatchConfig, TaskDispatcher
from arforge.multiagent.metrics import (
    DispatchMetricsCollector,
    format_dispatch_report,
)
from arforge.multiagent.protocol import Conversation, Task, TaskResult
from arforge.multiagent.router import (
    DynamicTaskRouter,
    EscalationRecord,
    RouterConfig,
)
from arforge.multiagent.sub_agent import (
    AgentChannel,
    AgentStatus,
    SubAgent,
    get_agent_status,
    set_agent_status,
)
from arforge.multiagent.sub_agent_pool import SubAgentPool


# ====================================================================
# 1. Thread-Safe Shared Memory
# ====================================================================


class TestThreadSafeSharedMemory:
    """Concurrent writes to Conversation must not corrupt data."""

    def test_concurrent_channel_writes(self):
        """Multiple threads sending messages must not lose any."""
        conv = Conversation(master_goal="test")

        def send_messages(role: str, count: int):
            ch = AgentChannel(conv, role)
            for i in range(count):
                ch.send("target", "info", f"msg-{role}-{i}")

        threads = [
            threading.Thread(target=send_messages, args=(f"Agent{i}", 50))
            for i in range(4)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All messages should be in the buffer
        msgs = AgentChannel(conv, "target").receive()
        assert len(msgs) == 200  # 4 agents * 50 messages

    def test_concurrent_status_updates(self):
        """Multiple threads updating agent status must not corrupt."""
        conv = Conversation(master_goal="test")

        def update_status(role: str):
            for i in range(20):
                status = AgentStatus(role=role, state="running", task_id=f"t{i}")
                set_agent_status(conv, status)

        threads = [
            threading.Thread(target=update_status, args=(f"Agent{i}",))
            for i in range(4)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Each agent's status should exist
        for i in range(4):
            s = get_agent_status(conv, f"Agent{i}")
            assert s.role == f"Agent{i}"
            assert s.state == "running"

    def test_concurrent_result_appends(self):
        """Thread-safe result append via conversation.append_result."""
        conv = Conversation(master_goal="test")

        def append_results(role: str, count: int):
            for i in range(count):
                conv.append_result(
                    TaskResult(
                        task_id=f"{role}-{i}", role=role,
                        success=True, output="ok",
                    )
                )

        threads = [
            threading.Thread(target=append_results, args=(f"Agent{i}", 25))
            for i in range(4)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        snapshot = conv.get_results_snapshot()
        assert len(snapshot) == 100

    def test_conversation_cancellation_thread_safe(self):
        """Cancel + cancelled check must be thread-safe."""
        conv = Conversation(master_goal="test")

        seen_cancelled = []

        def worker():
            for _ in range(100):
                if conv.cancelled:
                    seen_cancelled.append(True)
                    return
                time.sleep(0.001)
            seen_cancelled.append(False)

        t = threading.Thread(target=worker)
        t.start()
        time.sleep(0.02)
        conv.cancel("test")
        t.join()

        assert seen_cancelled[0] is True


# ====================================================================
# 2. Agent Instance Pooling
# ====================================================================


class TestAgentPooling:
    """SubAgentPool borrow/return/cache."""

    def test_borrow_creates_new_instance(self):
        pool = SubAgentPool.instance()
        agent = pool.borrow_agent("CoderAgent")
        assert agent is not None
        assert agent.role == "CoderAgent"

    def test_return_and_reuse(self):
        pool = SubAgentPool.instance()
        pool.clear_pool()

        a1 = pool.borrow_agent("CoderAgent")
        pool.return_agent("CoderAgent", a1)
        a2 = pool.borrow_agent("CoderAgent")

        # Should reuse the same instance
        assert a1 is a2

    def test_pool_is_capped(self):
        pool = SubAgentPool.instance()
        pool.clear_pool()

        agents = [pool.borrow_agent("CoderAgent") for _ in range(12)]
        for a in agents:
            pool.return_agent("CoderAgent", a)

        stats = pool.pool_stats()
        assert "CoderAgent" in stats
        assert stats["CoderAgent"]["max"] == 8
        assert stats["CoderAgent"]["cached"] == stats["CoderAgent"]["max"]

    def test_borrow_unknown_role_returns_none(self):
        pool = SubAgentPool.instance()
        agent = pool.borrow_agent("NonExistentRole")
        assert agent is None

    def test_clear_pool_removes_all(self):
        pool = SubAgentPool.instance()
        a = pool.borrow_agent("CoderAgent")
        pool.return_agent("CoderAgent", a)
        assert pool.pool_stats()

        pool.clear_pool()
        assert not pool.pool_stats()


# ====================================================================
# 3. Dynamic Task Routing
# ====================================================================


class TestDynamicRouting:
    """Escalation of failed tasks to recovery agents."""

    def test_router_classifies_syntax_error(self):
        router = DynamicTaskRouter()
        role = router.classify_error("SyntaxError: invalid syntax at line 42")
        assert role == "DebuggerAgent"

    def test_router_classifies_timeout(self):
        router = DynamicTaskRouter()
        role = router.classify_error("Task timeout after 60000ms")
        assert role == "CoderAgent"

    def test_router_classifies_not_found(self):
        router = DynamicTaskRouter()
        role = router.classify_error("Module not found: nonexistent_package")
        assert role == "SearcherAgent"

    def test_router_classifies_unknown_as_debugger(self):
        router = DynamicTaskRouter()
        role = router.classify_error("Something completely unexpected happened")
        assert role == "DebuggerAgent"

    def test_escalate_creates_recovery_task(self):
        router = DynamicTaskRouter()
        conv = Conversation(master_goal="fix bug")
        task = Task(task_id="t1", role="CoderAgent", goal="fix bug")

        failed = TaskResult(
            task_id="t1", role="CoderAgent", success=False,
            error="SyntaxError: invalid syntax at line 42",
        )

        recovery = router.escalate(failed, task, conv)
        assert recovery is not None
        assert recovery.role == "DebuggerAgent"
        assert "Escalation L1" in recovery.goal
        assert "SyntaxError" in recovery.goal

    def test_max_escalation_depth_respected(self):
        router = DynamicTaskRouter(RouterConfig(max_escalation_depth=1))
        conv = Conversation(master_goal="test")
        task = Task(task_id="t1", role="CoderAgent", goal="test")

        # First escalation: allowed
        router.mark_escalated("t1", depth=1)
        assert not router.should_escalate(task, conv)

    def test_escalation_recorded_in_shared_memory(self):
        router = DynamicTaskRouter()
        conv = Conversation(master_goal="test")
        task = Task(task_id="t2", role="CoderAgent", goal="test")
        failed = TaskResult(task_id="t2", role="CoderAgent", success=False, error="timeout")

        router.escalate(failed, task, conv)
        records = conv.get_shared("_escalation_t2", [])
        assert len(records) == 1
        assert records[0]["original_role"] == "CoderAgent"


# ====================================================================
# 4. Cancellation Tokens
# ====================================================================


class TestCancellation:
    """Conversation cancellation stops dispatch."""

    def test_cancelled_property(self):
        conv = Conversation(master_goal="test")
        assert conv.cancelled is False
        conv.cancel("stop")
        assert conv.cancelled is True

    def test_cancel_reason_stored(self):
        conv = Conversation(master_goal="test")
        conv.cancel("budget exceeded")
        assert conv.get_shared("_cancel_reason") == "budget exceeded"

    def test_dispatch_honours_cancellation(self):
        """Dispatch with cancelled conversation returns aborted results."""
        conv = Conversation(master_goal="test")
        conv.cancel("test cancel")

        tasks = [
            Task(task_id="t1", role="CoderAgent", goal="task1"),
            Task(task_id="t2", role="CoderAgent", goal="task2"),
        ]

        # Use a real TaskDispatcher but with cancelled conversation
        d = TaskDispatcher(max_parallel=1)

        # Mock pool that would succeed but should never be called
        mock_pool = SimpleNamespace(
            create_agent=lambda role: None,
            borrow_agent=lambda role: None,
            return_agent=lambda role, agent: None,
        )
        d._pool = mock_pool

        results = d.dispatch(tasks, conv)
        assert all("cancelled" in (r.error or "").lower() for r in results)

    def test_task_timeout_is_real_and_does_not_retry_or_repool_worker(self):
        """A blocking legacy worker must not defeat the dispatcher deadline."""
        calls = []
        returned = []

        class BlockingAgent:
            def execute(self, task, conversation):
                calls.append(task.task_id)
                time.sleep(0.5)
                return TaskResult(
                    task_id=task.task_id,
                    role=task.role,
                    success=True,
                    output="late",
                )

        dispatcher = TaskDispatcher(
            config=DispatchConfig(max_retries=2, timeout_grace_ms=0)
        )
        dispatcher._pool = SimpleNamespace(
            borrow_agent=lambda role: BlockingAgent(),
            create_agent=lambda role: BlockingAgent(),
            return_agent=lambda role, agent: returned.append(agent),
        )
        conversation = Conversation(master_goal="bounded work")
        task = Task(
            task_id="bounded",
            role="CoderAgent",
            goal="block",
            deadline_ms=30,
        )

        started = time.perf_counter()
        result = dispatcher._execute_one(task, conversation)
        elapsed = time.perf_counter() - started

        assert elapsed < 0.25
        assert result.success is False
        assert "timeout" in result.error
        assert calls == ["bounded"]
        assert returned == []
        assert conversation.task_cancelled("bounded") is True

    def test_conversation_progress_and_task_cancellation_are_runtime_only(self):
        events = []
        conversation = Conversation(master_goal="observable")
        conversation.set_progress_callback(
            lambda event, data: events.append((event, data["conversation_id"]))
        )

        conversation.emit_progress("phase_start", phase="dispatch")
        conversation.reset_task_cancellation("t1")
        conversation.cancel_task("t1", "deadline")

        assert events[0] == ("phase_start", conversation.conversation_id)
        assert events[-1][0] == "task_cancel_requested"
        assert conversation.task_cancelled("t1") is True
        payload = conversation.to_dict()
        assert "_progress_callback" not in payload
        assert "_task_cancel_events" not in payload

    def test_total_deadline_participates_in_cancellation(self):
        conversation = Conversation(master_goal="bounded pipeline")
        conversation.set_deadline(0.01)
        time.sleep(0.02)

        assert conversation.expired is True
        assert conversation.task_cancelled("future-task") is True


def test_agentic_subagent_propagates_deadline_cancellation_and_progress(monkeypatch):
    captured = {}
    events = []
    sentinel = object()

    def fake_run_tool_loop(adapter, messages, **kwargs):
        captured.update(kwargs)
        kwargs["on_tool_start"]("read_file", {"path": "a.py"}, 1)
        kwargs["on_tool_complete"](
            "read_file",
            {"path": "a.py"},
            SimpleNamespace(success=True, error=""),
            1,
        )
        return sentinel

    monkeypatch.setattr("arforge.core.agentic.run_tool_loop", fake_run_tool_loop)
    agent = SubAgent()
    agent.role = "SearcherAgent"
    agent.tools = ["read_file"]
    monkeypatch.setattr(agent, "_get_adapter", lambda: object())
    monkeypatch.setattr(agent, "_allowed_tools", lambda: [])
    conversation = Conversation(master_goal="inspect")
    conversation.set_progress_callback(lambda event, data: events.append((event, data)))
    conversation.reset_task_cancellation("search")
    task = Task(
        task_id="search",
        role="SearcherAgent",
        goal="inspect",
        deadline_ms=5000,
    )

    assert agent.run_agentic_task(task, conversation) is sentinel
    assert callable(captured["should_stop"])
    assert captured["model_timeout_seconds"] <= 5
    assert [event for event, _ in events] == ["agent_tool_start", "agent_tool_end"]

    conversation.cancel_task("search", "user stop")
    assert captured["should_stop"]() is True


def test_dispatcher_propagates_master_to_pool_agents():
    received = []
    master = object()

    class FastAgent:
        def execute(self, task, _conversation):
            return TaskResult(
                task_id=task.task_id,
                role=task.role,
                success=True,
                output="done",
            )

    def borrow(role, master=None):
        received.append((role, master))
        return FastAgent()

    dispatcher = TaskDispatcher(master=master, max_retries=0)
    dispatcher._pool = SimpleNamespace(
        borrow_agent=borrow,
        create_agent=lambda role, master=None: FastAgent(),
        return_agent=lambda role, agent: None,
    )
    conversation = Conversation(master_goal="shared provider")
    task = Task(task_id="one", role="CoderAgent", goal="work")

    assert dispatcher._execute_one(task, conversation).success is True
    assert received == [("CoderAgent", master)]


def test_direct_subagent_uses_cwd_independent_secure_model_runtime(monkeypatch):
    adapter = object()
    runtime = SimpleNamespace(create_active_adapter=lambda: adapter)
    monkeypatch.setattr(
        "arforge.product.model_config_runtime.get_model_config", lambda: runtime
    )

    assert SubAgent()._get_adapter() is adapter


# ====================================================================
# 5. Circuit Breaker
# ====================================================================


class TestCircuitBreaker:
    """Consecutive failures trigger dispatch abort."""

    def test_catastrophic_failure_stops_remaining_levels(self):
        """If all tasks in one level fail, next levels abort."""
        conv = Conversation(master_goal="test")
        t1 = Task(task_id="t1", role="CoderAgent", goal="task1", depends_on=[])
        t2 = Task(task_id="t2", role="CoderAgent", goal="task2", depends_on=["t1"])
        conv.tasks = [t1, t2]

        class Failing(SubAgent):
            role = "CoderAgent"
            tools = []
            agentic_first = False
            def _run(self, task, conv):
                raise RuntimeError("fail")

        d = TaskDispatcher(max_parallel=1)
        d._pool = SimpleNamespace(
            create_agent=lambda role: Failing(),
            borrow_agent=lambda role: None,
            return_agent=lambda role, agent: None,
        )

        results = d.dispatch(conv.tasks, conv)
        assert len(results) == 2
        aborted = [r for r in results if "aborted" in (r.error or "")]
        assert len(aborted) == 1


# ====================================================================
# 6. DispatchMetrics
# ====================================================================


class TestDispatchMetrics:
    """Collector accuracy and report formatting."""

    def test_collector_basic_counting(self):
        c = DispatchMetricsCollector()
        c.record_task("CoderAgent", True, 100, 50)
        c.record_task("CoderAgent", False, 50, 30)
        c.record_task("ReviewerAgent", True, 200, 80)

        report = c.build_report("conv1", total_tasks=3)
        assert report.tasks_succeeded == 2
        assert report.tasks_failed == 1
        assert report.tokens_used == 350  # 100 + 50 + 200
        assert report.total_tasks == 3

    def test_collector_per_agent_breakdown(self):
        c = DispatchMetricsCollector()
        c.record_task("CoderAgent", True, 100, 50)
        c.record_task("CoderAgent", True, 200, 60)
        c.record_task("TesterAgent", False, 50, 30)

        report = c.build_report("conv2", total_tasks=3)
        assert "CoderAgent" in report.agent_metrics
        assert report.agent_metrics["CoderAgent"].success_rate == 1.0
        assert report.agent_metrics["TesterAgent"].success_rate == 0.0

    def test_collector_escalation_tracking(self):
        c = DispatchMetricsCollector()
        c.record_task("CoderAgent", True, 100, 50, escalated=True)
        c.record_escalation()

        report = c.build_report("conv3", total_tasks=1)
        assert report.escalations_performed == 1
        assert report.agent_metrics["CoderAgent"].escalations == 1

    def test_collector_circuit_breaker(self):
        c = DispatchMetricsCollector()
        c.mark_circuit_breaker()
        report = c.build_report("conv4", total_tasks=5)
        assert report.circuit_breaker_triggered is True

    def test_report_formatting(self):
        c = DispatchMetricsCollector()
        c.record_task("CoderAgent", True, 150, 100)
        c.record_task("ReviewerAgent", True, 50, 60)

        report = c.build_report("test-conv", total_tasks=2)
        formatted = format_dispatch_report(report)

        assert "Multi-Agent Dispatch Report" in formatted
        assert "Success Rate:  100%" in formatted
        assert "CoderAgent" in formatted
        assert "ReviewerAgent" in formatted
        assert "150" in formatted

    def test_empty_report(self):
        c = DispatchMetricsCollector()
        report = c.build_report("empty")
        assert report.success_rate == 1.0  # 0/0 = 1.0 by convention
        formatted = format_dispatch_report(report)
        assert "Success Rate:  100%" in formatted


# ====================================================================
# 7. End-to-End: Full dispatch with all features
# ====================================================================


class TestEndToEndPhase2:
    """Full pipeline: pool → dispatch → router → metrics → report."""

    def test_full_dispatch_with_metrics(self):
        """Dispatch real tasks through a pooled dispatcher and get a report."""
        conv = Conversation(master_goal="e2e test")

        class FastAgent(SubAgent):
            role = "CoderAgent"
            tools = []
            agentic_first = False
            def _run(self, task, conv):
                time.sleep(0.01)
                return f"done {task.task_id}", {}, [], []

        tasks = [
            Task(task_id="e2e_0", role="CoderAgent", goal="task 1"),
            Task(task_id="e2e_1", role="CoderAgent", goal="task 2"),
        ]

        pool = SubAgentPool.instance()
        original = pool.get("CoderAgent")
        pool.register(FastAgent)
        try:
            cfg = DispatchConfig(max_parallel=2)
            d = TaskDispatcher(config=cfg)

            results = d.dispatch(tasks, conv)
            assert len(results) == 2
            assert all(r.success for r in results)

            # Build report
            report = d.metrics.build_report(conv.conversation_id, total_tasks=2)
            assert report.tasks_succeeded == 2
            assert report.tokens_used >= 0  # FastAgent returns 0 tokens
        finally:
            if original is not None:
                pool.register(original)


# ====================================================================
# 8. RouterConfig and EscalationRecord
# ====================================================================


class TestRouterDataClassesRegression:
    def test_router_config_defaults(self):
        cfg = RouterConfig()
        assert cfg.max_escalation_depth == 2
        assert cfg.enable_debugger_escalation is True
        assert "syntax" in cfg.error_role_map

    def test_escalation_record_to_dict(self):
        record = EscalationRecord(
            original_task_id="t1",
            original_role="CoderAgent",
            escalated_role="DebuggerAgent",
            error_summary="syntax error",
            timestamp=123456.0,
        )
        d = record.to_dict()
        assert d["original_task_id"] == "t1"
        assert d["escalated_role"] == "DebuggerAgent"


# ====================================================================
# 9. SubAgent Delegation and Handoff
# ====================================================================


class TestDelegation:
    """SubAgent delegate_to() and handoff() create tasks on the delegation queue."""

    def test_delegate_to_enqueues_task(self):
        from arforge.multiagent.sub_agent import SubAgent
        from arforge.multiagent.protocol import Conversation

        conv = Conversation(master_goal="test")
        agent = SubAgent()
        agent.role = "CoderAgent"

        task_id = agent.delegate_to(conv, "TesterAgent", "Run integration tests")
        assert task_id is not None
        assert task_id.startswith("delegated_CoderAgent")

        delegated = conv.drain_delegated_tasks()
        assert len(delegated) == 1
        assert delegated[0].role == "TesterAgent"
        assert "Run integration tests" in delegated[0].goal

    def test_delegate_to_drains_cleanly(self):
        from arforge.multiagent.sub_agent import SubAgent
        from arforge.multiagent.protocol import Conversation

        conv = Conversation(master_goal="test")
        agent = SubAgent()
        agent.role = "PlannerAgent"

        agent.delegate_to(conv, "CoderAgent", "Task A")
        agent.delegate_to(conv, "CoderAgent", "Task B")
        agent.delegate_to(conv, "ReviewerAgent", "Task C")

        delegated = conv.drain_delegated_tasks()
        assert len(delegated) == 3

        # Second drain should be empty
        assert len(conv.drain_delegated_tasks()) == 0

    def test_handoff_enqueues_delegated_task(self):
        from arforge.multiagent.sub_agent import SubAgent
        from arforge.multiagent.protocol import Conversation

        conv = Conversation(master_goal="test")
        agent = SubAgent()
        agent.role = "CoderAgent"

        task_id = agent.handoff(conv, "ReviewerAgent", {"goal": "Review this code", "files": ["a.py"]})
        assert task_id is not None

        delegated = conv.drain_delegated_tasks()
        assert len(delegated) == 1
        assert delegated[0].role == "ReviewerAgent"

    def test_delegation_within_dispatcher(self):
        """A task executed by the dispatcher can spawn delegated tasks mid-dispatch."""
        from arforge.multiagent.protocol import Conversation, Task
        from arforge.multiagent.sub_agent import SubAgent
        from arforge.multiagent.dispatcher import TaskDispatcher
        from types import SimpleNamespace
        import time

        conv = Conversation(master_goal="test")

        class DelegatingAgent(SubAgent):
            role = "CoderAgent"
            tools = []
            agentic_first = False
            def _run(self, task, conv):
                # Spawn two child tasks
                self.delegate_to(conv, "TesterAgent", "Test module A")
                self.delegate_to(conv, "TesterAgent", "Test module B")
                return "done", {}, [], []

        class WorkerAgent(SubAgent):
            role = "TesterAgent"
            tools = []
            agentic_first = False
            def _run(self, task, conv):
                time.sleep(0.01)
                return f"tested: {task.goal}", {}, [], []

        tasks = [Task(task_id="t1", role="CoderAgent", goal="do work")]

        pool = SimpleNamespace(
            create_agent=lambda role: DelegatingAgent() if role == "CoderAgent" else WorkerAgent(),
            borrow_agent=lambda role: None,
            return_agent=lambda role, agent: None,
        )

        d = TaskDispatcher(max_parallel=2)
        d._pool = pool

        results = d.dispatch(tasks, conv)
        # Original task + 2 delegated tasks = 3 results
        assert len(results) == 3
        assert sum(1 for r in results if r.success) == 3


# ====================================================================
# 10. Per-Role Concurrency Control
# ====================================================================


class TestRoleConcurrency:
    """Per-role semaphore limits concurrent tasks per role."""

    def test_semaphore_acquire_and_release(self):
        from arforge.multiagent.dispatcher import TaskDispatcher

        d = TaskDispatcher()
        assert d._max_per_role == 2

        # Acquire 2 slots for CoderAgent
        assert d._acquire_role_slot("CoderAgent") is True
        assert d._acquire_role_slot("CoderAgent") is True

        # Release one, should be able to acquire again
        d._release_role_slot("CoderAgent")
        assert d._acquire_role_slot("CoderAgent") is True

        # Cleanup
        d._release_role_slot("CoderAgent")
        d._release_role_slot("CoderAgent")

    def test_semaphore_per_role_isolation(self):
        from arforge.multiagent.dispatcher import TaskDispatcher

        d = TaskDispatcher()

        # Different roles have independent semaphores
        assert d._acquire_role_slot("CoderAgent") is True
        assert d._acquire_role_slot("CoderAgent") is True
        assert d._acquire_role_slot("ReviewerAgent") is True
        assert d._acquire_role_slot("TesterAgent") is True

        d._release_role_slot("CoderAgent")
        d._release_role_slot("CoderAgent")
        d._release_role_slot("ReviewerAgent")
        d._release_role_slot("TesterAgent")


class TestRouterDataClasses:
    def test_router_config_defaults(self):
        cfg = RouterConfig()
        assert cfg.max_escalation_depth == 2
        assert cfg.enable_debugger_escalation is True
        assert "syntax" in cfg.error_role_map

    def test_escalation_record_to_dict(self):
        record = EscalationRecord(
            original_task_id="t1",
            original_role="CoderAgent",
            escalated_role="DebuggerAgent",
            error_summary="syntax error",
            timestamp=123456.0,
        )
        d = record.to_dict()
        assert d["original_task_id"] == "t1"
        assert d["escalated_role"] == "DebuggerAgent"
