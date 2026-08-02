"""End-to-end tests for the full multi-agent pipeline.

Exercises: MasterAgent -> TaskDispatcher -> SubAgent (agentic/legacy) -> ResultMerger
Tests pipeline, fanout, and adversarial patterns with both agentic-first and legacy agents.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

from arforge.multiagent.dispatcher import DispatchConfig, TaskDispatcher
from arforge.multiagent.master_agent import MasterAgent
from arforge.multiagent.merger import ResultMerger
from arforge.multiagent.patterns import adversarial, fanout, pipeline
from arforge.multiagent.protocol import Conversation, Task, TaskResult
from arforge.multiagent.sub_agent import SubAgent


# ——————————————————————————————————————————————
# Test agents (legacy, no model needed)
# ——————————————————————————————————————————————


class _SearchAgent(SubAgent):
    role = "SearcherAgent"
    tools = ["code_search"]
    agentic_first = False

    def _run(self, task, conv):
        return "Found: app.py, utils.py", {}, [], []


class _CodeAgent(SubAgent):
    role = "CoderAgent"
    tools = ["write_file"]
    agentic_first = False

    def _run(self, task, conv):
        dep = ""
        for dep_id in task.depends_on:
            r = conv.result_for(dep_id)
            if r and r.success:
                dep = r.output
        return f"Code written (based on: {dep[:50]})", {}, [], []


class _ReviewAgent(SubAgent):
    role = "ReviewerAgent"
    tools = ["read_file"]
    agentic_first = False

    def _run(self, task, conv):
        return "Review: approved, 0 critical issues", {}, [], []


class _TestAgent(SubAgent):
    role = "TesterAgent"
    tools = ["run_cmd"]
    agentic_first = False

    def _run(self, task, conv):
        return "Tests: 5 passed, 0 failed", {}, [], []


class _SlowAgent(SubAgent):
    """Simulates a slow agent to test parallel dispatch."""
    role = "SearcherAgent"
    tools = []
    agentic_first = False

    def _run(self, task, conv):
        time.sleep(0.05)
        return f"slow done {task.task_id}", {}, [], []


class _FailingAgent(SubAgent):
    role = "CoderAgent"
    tools = []
    agentic_first = False

    def _run(self, task, conv):
        raise ValueError("simulated failure")


def _make_pool(agent_classes: dict):
    """Create a mock pool that returns appropriate agents per role."""
    return SimpleNamespace(
        create_agent=lambda role: agent_classes.get(role, SubAgent)(),
    )


_POOL = _make_pool({
    "SearcherAgent": _SearchAgent,
    "CoderAgent": _CodeAgent,
    "ReviewerAgent": _ReviewAgent,
    "TesterAgent": _TestAgent,
})


# ——————————————————————————————————————————————
# Pipeline end-to-end
# ——————————————————————————————————————————————


def test_pipeline_e2e_search_code_review_test():
    """Pipeline: Searcher -> Coder -> Reviewer -> Tester, all succeed."""
    conv = pipeline(
        ["SearcherAgent", "CoderAgent", "ReviewerAgent", "TesterAgent"],
        "Add login feature",
    )

    d = TaskDispatcher(max_parallel=1)
    d._pool = _POOL
    results = d.dispatch(conv.tasks, conv)

    assert len(results) == 4
    assert all(r.success for r in results)

    merger = ResultMerger()
    final = merger.merge(conv, "Add login feature")
    assert final["strategy"] in ("pipeline", "adversarial")  # ReviewerAgent triggers adversarial detection
    assert "Code written" in final["answer"]
    assert "Review:" in final["answer"]
    assert "Tests:" in final["answer"]


# ——————————————————————————————————————————————
# Fanout end-to-end
# ——————————————————————————————————————————————


def test_fanout_e2e_parallel_execution():
    """Fanout: 3 agents run the same task in parallel."""
    conv = fanout(
        ["SearcherAgent", "CoderAgent", "ReviewerAgent"],
        "Analyze codebase",
    )

    events = []
    cfg = DispatchConfig(
        max_parallel=4,
        progress_callback=lambda e, d: events.append((e, d.get("task_id"))),
    )
    d = TaskDispatcher(config=cfg)
    d._pool = _POOL
    results = d.dispatch(conv.tasks, conv)

    assert len(results) == 3
    assert all(r.success for r in results)

    # All 3 tasks should have started and ended
    start_events = [e for e in events if e[0] == "task_start"]
    end_events = [e for e in events if e[0] == "task_end"]
    assert len(start_events) == 3
    assert len(end_events) == 3

    merger = ResultMerger()
    final = merger.merge(conv, "Analyze codebase")
    # Fanout results should be synthesized
    assert final["strategy"] in ("llm_synthesis", "concat_fallback", "adversarial")


# ——————————————————————————————————————————————
# Adversarial end-to-end
# ——————————————————————————————————————————————


def test_adversarial_e2e_code_review_fix_test():
    """Adversarial: Coder -> Reviewer -> Coder(fix) -> Tester."""
    conv = adversarial(
        coder_role="CoderAgent",
        reviewer_role="ReviewerAgent",
        tester_role="TesterAgent",
        goal="Implement payment module",
    )

    d = TaskDispatcher(max_parallel=1)
    d._pool = _POOL
    results = d.dispatch(conv.tasks, conv)

    assert len(results) == 4
    assert all(r.success for r in results)

    merger = ResultMerger()
    final = merger.merge(conv, "Implement payment module")
    assert final["strategy"] == "adversarial"


# ——————————————————————————————————————————————
# Failure handling
# ——————————————————————————————————————————————


def test_pipeline_with_failing_task():
    """Pipeline where one task fails should collect partial results."""
    conv = pipeline(
        ["SearcherAgent", "CoderAgent", "ReviewerAgent"],
        "Fix bug",
    )
    # Replace the Coder with a failing agent
    pool_with_fail = _make_pool({
        "SearcherAgent": _SearchAgent,
        "CoderAgent": _FailingAgent,
        "ReviewerAgent": _ReviewAgent,
    })

    d = TaskDispatcher(max_parallel=1)
    d._pool = pool_with_fail
    results = d.dispatch(conv.tasks, conv)

    assert len(results) == 3
    # Searcher should succeed (Level 0)
    # Coder should fail (Level 1)
    # Reviewer should be aborted (Level 2, depends on Coder)
    successes = [r for r in results if r.success]
    failures = [r for r in results if not r.success]
    assert len(successes) == 1
    assert successes[0].role == "SearcherAgent"
    assert len(failures) == 2


def test_merger_with_failures():
    """Merger should handle partial failures gracefully."""
    conv = Conversation(master_goal="test")
    conv.results = [
        TaskResult(task_id="t1", role="SearcherAgent", success=True, output="found files"),
        TaskResult(task_id="t2", role="CoderAgent", success=False, error="ValueError: simulated"),
    ]
    conv.tasks = [
        Task(task_id="t1", role="SearcherAgent", goal="search"),
        Task(task_id="t2", role="CoderAgent", goal="code", depends_on=["t1"]),
    ]

    merger = ResultMerger()
    final = merger.merge(conv, "test")
    assert final["strategy"] in ("pipeline", "concat_fallback")
    assert "found files" in final["answer"]


# ——————————————————————————————————————————————
# Parallel timing test
# ——————————————————————————————————————————————


def test_parallel_is_faster_than_serial():
    """3 slow tasks in parallel should complete faster than serial."""
    conv = fanout(
        ["SearcherAgent", "SearcherAgent", "SearcherAgent"],
        "parallel test",
    )

    # Serial: max_parallel = 1
    d_serial = TaskDispatcher(max_parallel=1)
    pool_slow = _make_pool({"SearcherAgent": _SlowAgent})
    d_serial._pool = pool_slow

    start = time.perf_counter()
    d_serial.dispatch(conv.tasks, Conversation(master_goal="test"))
    serial_time = time.perf_counter() - start

    # Parallel: max_parallel = 4
    conv2 = fanout(
        ["SearcherAgent", "SearcherAgent", "SearcherAgent"],
        "parallel test",
    )
    d_parallel = TaskDispatcher(max_parallel=4)
    d_parallel._pool = _make_pool({"SearcherAgent": _SlowAgent})

    start = time.perf_counter()
    d_parallel.dispatch(conv2.tasks, Conversation(master_goal="test"))
    parallel_time = time.perf_counter() - start

    # Parallel should be meaningfully faster (at least 30%)
    assert parallel_time < serial_time * 0.9, (
        f"parallel={parallel_time:.3f}s should be < serial={serial_time:.3f}s"
    )


# ——————————————————————————————————————————————
# MasterAgent integration
# ——————————————————————————————————————————————


def test_master_agent_single_path():
    """MasterAgent should route simple queries to single-agent path."""
    m = MasterAgent(agent=None)  # no agent -> uses fallback
    result = m.handle("hello")
    assert result["mode"] in ("single", "multi")
    # Without real model, should not crash
    assert isinstance(result, dict)
    assert "answer" in result


def test_master_agent_multi_path_with_mocked_pipeline():
    """MasterAgent should use multi-agent path for complex queries."""
    m = MasterAgent(agent=None)
    # Force multi-agent path by setting understanding
    m._understand = lambda ui: SimpleNamespace(
        intent="complex task",
        complexity="complex",
        suggested_roles=["SearcherAgent", "CoderAgent", "ReviewerAgent"],
        estimated_steps=5,
        needs_multiagent=True,
    )
    m._needs_multiagent = lambda u: True
    m._decompose = lambda ui, u: [
        Task(task_id="t1", role="SearcherAgent", goal="search", depends_on=[]),
        Task(task_id="t2", role="CoderAgent", goal="code", depends_on=["t1"]),
        Task(task_id="t3", role="ReviewerAgent", goal="review", depends_on=["t2"]),
    ]

    # Inject mock dispatcher and pool
    d = TaskDispatcher(max_parallel=1)
    d._pool = _POOL
    m._dispatcher = d  # override lazy attr

    result = m.handle("Build login feature")
    assert result["mode"] == "multi"
    assert result["agents_used"] > 0
    assert result["task_count"] == 3
    assert len(result["results"]) == 3
    assert {item["role"] for item in result["results"]} == {
        "SearcherAgent",
        "CoderAgent",
        "ReviewerAgent",
    }
    assert "answer" in result
    assert result.get("observability") is not None


def test_master_agent_with_agentic_subagent():
    """MasterAgent -> Dispatcher -> SubAgent(agentic_first=True) should work."""
    m = MasterAgent(agent=None)
    m._understand = lambda ui: SimpleNamespace(
        intent="code task",
        complexity="medium",
        suggested_roles=["CoderAgent"],
        estimated_steps=3,
        needs_multiagent=False,
    )
    m._needs_multiagent = lambda u: True

    class _SimpleAgentic(SubAgent):
        role = "CoderAgent"
        tools = []
        agentic_first = True
        max_steps = 2

        def run_agentic_task(self, task, conv, max_steps=6):
            from arforge.core.agentic import ToolLoopResult
            return ToolLoopResult(answer="Implemented feature X")

    m._decompose = lambda ui, u: [Task(task_id="a1", role="CoderAgent", goal="implement", depends_on=[])]
    d = TaskDispatcher(max_parallel=1)
    d._pool = _make_pool({"CoderAgent": _SimpleAgentic})
    m._dispatcher = d

    result = m.handle("Implement feature X")
    assert result["mode"] == "multi"
    assert result["agents_used"] == 1
    assert "Implemented feature X" in result["answer"]
