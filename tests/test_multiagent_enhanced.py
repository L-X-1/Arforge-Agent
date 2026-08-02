"""Integration tests for enhanced multi-agent parallel execution (Phase 2-3).

Covers:
  - Agentic-first SubAgent execution (agentic_first=True default)
  - AgentChannel inter-agent communication
  - AgentStatus tracking and query
  - TaskDispatcher with DispatchConfig (resource-aware, progress callbacks)
  - Parallel dispatch with progress streaming
  - Inter-agent message injection into prompts
  - Backward compatibility (agentic_first=False legacy path)
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

from arforge.multiagent.dispatcher import DispatchConfig, TaskDispatcher
from arforge.multiagent.protocol import AgentRole, Conversation, Task, TaskResult
from arforge.multiagent.sub_agent import (
    AgentChannel,
    AgentMessage,
    AgentStatus,
    SubAgent,
    get_agent_status,
    get_all_agent_statuses,
    set_agent_status,
)


# ——————————————————————————————————————————————
# Test helpers
# ——————————————————————————————————————————————


class _TestAgent(SubAgent):
    role = "TestAgent"
    tools = ["calculate"]
    system_prompt = "You are a test agent."
    max_steps = 3


class _LegacyAgent(SubAgent):
    role = "LegacyAgent"
    agentic_first = False
    tools = []
    system_prompt = "legacy"


# ——————————————————————————————————————————————
# Test: Agentic-first SubAgent
# ——————————————————————————————————————————————


def test_subagent_defaults_to_agentic_first():
    a = _TestAgent()
    assert a.agentic_first is True
    assert a.max_steps == 3


def test_subagent_can_opt_out_of_agentic():
    a = _LegacyAgent()
    assert a.agentic_first is False


def test_subagent_execute_agentic_calls_run_agentic_task():
    """When agentic_first=True, execute() must call run_agentic_task(), not _run()."""
    agent = _TestAgent()
    task = Task(task_id="t1", goal="test")
    conv = Conversation(master_goal="test")

    called_agentic = False
    original = agent.run_agentic_task

    def _fake_agentic(t, c, max_steps=6):
        nonlocal called_agentic
        called_agentic = True
        from arforge.core.agentic import ToolLoopResult
        return ToolLoopResult(answer="done")

    agent.run_agentic_task = _fake_agentic

    try:
        result = agent.execute(task, conv)
        assert called_agentic, "execute() must call run_agentic_task when agentic_first=True"
        assert result.success
    finally:
        agent.run_agentic_task = original


def test_subagent_execute_legacy_calls_run():
    """When agentic_first=False, execute() must call _run(), not run_agentic_task()."""
    agent = _LegacyAgent()
    task = Task(task_id="t2", goal="test")
    conv = Conversation(master_goal="test")

    called_run = False
    original = agent._run

    def _fake_run(t, c):
        nonlocal called_run
        called_run = True
        return "legacy output", {}, [], []

    agent._run = _fake_run

    try:
        result = agent.execute(task, conv)
        assert called_run, "execute() must call _run() when agentic_first=False"
        assert result.success
    finally:
        agent._run = original


def test_grounded_subagent_rejects_answer_without_evidence_tool_call():
    from arforge.core.agentic import ToolLoopResult
    from arforge.multiagent.agents.searcher_agent import SearcherAgent

    agent = SearcherAgent()
    agent.run_agentic_task = lambda *_args, **_kwargs: ToolLoopResult(
        answer="Invented file claims",
        tool_calls=[],
    )

    result = agent.execute(Task(task_id="search", role="SearcherAgent", goal="inspect"), Conversation())

    assert result.success is False
    assert "grounding required" in result.error


def test_grounded_subagent_accepts_successful_evidence_tool_call():
    from arforge.core.agentic import ToolLoopResult
    from arforge.multiagent.agents.searcher_agent import SearcherAgent

    agent = SearcherAgent()
    agent.run_agentic_task = lambda *_args, **_kwargs: ToolLoopResult(
        answer="Found billing.py",
        tool_calls=[{"tool": "list_code_files", "args": {}, "success": True, "step": 1}],
    )

    result = agent.execute(Task(task_id="search", role="SearcherAgent", goal="inspect"), Conversation())

    assert result.success is True


def test_grounded_subagent_tolerates_a_failed_optional_tool_after_evidence():
    from arforge.core.agentic import ToolLoopResult
    from arforge.multiagent.agents.searcher_agent import SearcherAgent

    agent = SearcherAgent()
    agent.run_agentic_task = lambda *_args, **_kwargs: ToolLoopResult(
        answer="The workspace is empty and ready for scaffolding.",
        tool_calls=[
            {"tool": "list_files", "args": {}, "success": True, "step": 1},
            {"tool": "web_search", "args": {}, "success": False, "step": 2},
        ],
        observability={"summary": {"errors": 1}},
    )

    result = agent.execute(Task(task_id="search", role="SearcherAgent", goal="inspect"), Conversation())

    assert result.success is True


# ——————————————————————————————————————————————
# Test: AgentChannel inter-agent communication
# ——————————————————————————————————————————————


def test_agent_channel_send_and_receive():
    conv = Conversation(master_goal="test")
    channel = AgentChannel(conv, "AgentA")

    channel.send("AgentB", "info", {"data": 42})
    channel.send("AgentC", "result", {"score": 0.99})
    channel.send("", "alert", {"msg": "broadcast"})  # broadcast

    # AgentB should see the direct message and broadcast
    msgs_b = AgentChannel(conv, "AgentB").receive()
    assert len(msgs_b) == 2  # direct + broadcast
    assert msgs_b[0].kind == "info"
    assert msgs_b[1].kind == "alert"

    # AgentC should see the direct result and broadcast
    msgs_c = AgentChannel(conv, "AgentC").receive()
    assert len(msgs_c) == 2  # direct + broadcast
    assert msgs_c[0].kind == "result"

    # AgentD should only see broadcast
    msgs_d = AgentChannel(conv, "AgentD").receive()
    assert len(msgs_d) == 1
    assert msgs_d[0].kind == "alert"


def test_agent_channel_latest_from():
    conv = Conversation(master_goal="test")
    channel = AgentChannel(conv, "Agency")

    channel.send("AgentB", "info", "first")
    time.sleep(0.01)
    channel.send("AgentB", "result", "second")

    latest = AgentChannel(conv, "AgentB").latest_from("Agency")
    assert latest is not None
    assert latest.kind == "result"
    assert latest.payload == "second"


def test_agent_channel_message_to_dict_roundtrip():
    msg = AgentMessage(sender="A", recipient="B", kind="handoff", payload={"files": ["x.py"]})
    d = msg.to_dict()
    msg2 = AgentMessage.from_dict(d)
    assert msg2.sender == "A"
    assert msg2.recipient == "B"
    assert msg2.kind == "handoff"
    assert msg2.payload == {"files": ["x.py"]}


# ——————————————————————————————————————————————
# Test: AgentStatus tracking
# ——————————————————————————————————————————————


def test_agent_status_set_and_get():
    conv = Conversation(master_goal="test")
    status = AgentStatus(role="CoderAgent", state="running", task_id="t1")
    set_agent_status(conv, status)

    got = get_agent_status(conv, "CoderAgent")
    assert got.state == "running"
    assert got.task_id == "t1"


def test_agent_status_get_nonexistent():
    conv = Conversation(master_goal="test")
    got = get_agent_status(conv, "UnknownAgent")
    assert got.role == "UnknownAgent"
    assert got.state == "idle"


def test_agent_status_get_all():
    conv = Conversation(master_goal="test")
    set_agent_status(conv, AgentStatus(role="A", state="done"))
    set_agent_status(conv, AgentStatus(role="B", state="running"))

    all_statuses = get_all_agent_statuses(conv)
    assert len(all_statuses) == 2
    assert all_statuses["A"].state == "done"
    assert all_statuses["B"].state == "running"


# ——————————————————————————————————————————————
# Test: DispatchConfig
# ——————————————————————————————————————————————


def test_dispatch_config_defaults():
    cfg = DispatchConfig()
    assert cfg.max_parallel == 4
    assert cfg.max_retries == 2
    assert cfg.resource_aware is True
    assert cfg.work_stealing is True


def test_dispatch_config_custom():
    cb_calls = []
    cfg = DispatchConfig(
        max_parallel=8, max_retries=5, resource_aware=False,
        progress_callback=lambda e, d: cb_calls.append(e),
    )
    assert cfg.max_parallel == 8
    assert cfg.resource_aware is False

    cfg.progress_callback("test", {})
    assert cb_calls == ["test"]


# ——————————————————————————————————————————————
# Test: TaskDispatcher with DispatchConfig
# ——————————————————————————————————————————————


def test_task_dispatcher_uses_config():
    cfg = DispatchConfig(max_parallel=5, resource_aware=False)
    d = TaskDispatcher(config=cfg)
    assert d.config.max_parallel == 5
    assert d.config.resource_aware is False


def _make_mock_pool(agent_class, role_override=None):
    """Create a mock pool that returns instances of agent_class."""
    return SimpleNamespace(
        create_agent=lambda role: agent_class(),
        borrow_agent=lambda role: None,
        return_agent=lambda role, agent: None,
    )


def test_task_dispatcher_parallel_fanout():
    """Fanout tasks with no dependencies should execute in parallel."""
    from arforge.multiagent.patterns import fanout

    conv = fanout(["CoderAgent", "CoderAgent", "CoderAgent"], "parallel test")

    events = []
    cfg = DispatchConfig(max_parallel=4, progress_callback=lambda e, d: events.append((e, d.get("task_id"))))
    d = TaskDispatcher(config=cfg)

    # Inject mock pool that returns fast-noop agents
    class _Fast(SubAgent):
        role = "CoderAgent"
        tools = []
        agentic_first = False

        def _run(self, task, conv):
            time.sleep(0.01)
            return f"done {task.task_id}", {}, [], []

    d._pool = _make_mock_pool(_Fast)
    results = d.dispatch(conv.tasks, conv)

    assert len(results) == 3
    assert all(r.success for r in results)

    start_events = [e for e in events if e[0] == "task_start"]
    end_events = [e for e in events if e[0] == "task_end"]
    assert len(start_events) == 3
    assert len(end_events) == 3


def test_task_dispatcher_pipeline_executes_sequentially():
    """Pipeline tasks with depends_on should execute in order."""
    from arforge.multiagent.patterns import pipeline

    conv = pipeline(["CoderAgent", "CoderAgent", "CoderAgent"], "sequential test")

    execution_order = []

    class _Ordered(SubAgent):
        role = "CoderAgent"
        tools = []
        agentic_first = False

        def _run(self, task, conv):
            execution_order.append(task.task_id)
            return f"done {task.task_id}", {}, [], []

    cfg = DispatchConfig(max_parallel=1)
    d = TaskDispatcher(config=cfg)
    d._pool = _make_mock_pool(_Ordered)
    results = d.dispatch(conv.tasks, conv)

    assert len(results) == 3
    assert all(r.success for r in results)
    # Tasks must execute in pipeline order (pipe_0 -> pipe_1 -> pipe_2)
    assert execution_order == ["pipe_0", "pipe_1", "pipe_2"]


def test_task_dispatcher_resource_aware_caps_workers():
    """Resource-aware dispatcher should cap workers by distinct roles."""
    d = TaskDispatcher(max_parallel=10)

    # 3 tasks, all same role -> cap at 2 (role_count * 2 = 2)
    tasks = [Task(role="CoderAgent", goal=f"task {i}") for i in range(3)]
    workers = d._compute_max_workers(tasks)
    assert workers == 2  # min(10, 3, 1*2) = 2

    # 2 tasks, 2 different roles -> cap at 2
    tasks = [Task(role="CoderAgent", goal="a"), Task(role="ReviewerAgent", goal="b")]
    workers = d._compute_max_workers(tasks)
    assert workers == 2  # min(10, 2, 2*2) = 2

    # 4 tasks, 3 different roles -> cap at 4
    tasks = [
        Task(role="CoderAgent", goal="a"),
        Task(role="CoderAgent", goal="b"),
        Task(role="ReviewerAgent", goal="c"),
        Task(role="TesterAgent", goal="d"),
    ]
    workers = d._compute_max_workers(tasks)
    assert workers == 4  # min(10, 4, 3*2) = 4


def test_task_dispatcher_catastrophic_failure_aborts():
    """If all tasks in a level fail, remaining levels are aborted."""
    conv = Conversation(master_goal="test")

    t1 = Task(task_id="t1", role="CoderAgent", goal="task1", depends_on=[])
    t2 = Task(task_id="t2", role="CoderAgent", goal="task2", depends_on=[])
    t3 = Task(task_id="t3", role="ReviewerAgent", goal="task3", depends_on=["t1"])

    conv.tasks = [t1, t2, t3]

    class _Failing(SubAgent):
        role = "CoderAgent"
        tools = []
        agentic_first = False

        def _run(self, task, conv):
            raise RuntimeError("simulated failure")

    cfg = DispatchConfig(max_parallel=2)
    d = TaskDispatcher(config=cfg)
    d._pool = _make_mock_pool(_Failing)
    results = d.dispatch(conv.tasks, conv)

    assert len(results) == 3
    failed = [r for r in results if not r.success]
    assert len(failed) == 3
    aborted = [r for r in results if "aborted" in (r.error or "")]
    assert len(aborted) == 1


def test_task_dispatcher_empty_tasks():
    d = TaskDispatcher()
    conv = Conversation(master_goal="test")
    results = d.dispatch([], conv)
    assert results == []


# ——————————————————————————————————————————————
# Test: SubAgent notify / ask / handoff helpers
# ——————————————————————————————————————————————


def test_subagent_notify_post_to_channel():
    conv = Conversation(master_goal="test")
    agent = _TestAgent()
    agent._channel = AgentChannel(conv, agent.role)

    agent.notify(conv, "ReviewerAgent", "info", "code ready for review")

    msgs = AgentChannel(conv, "ReviewerAgent").receive()
    assert len(msgs) == 1
    assert msgs[0].sender == "TestAgent"
    assert msgs[0].payload == "code ready for review"


def test_subagent_build_prompt_includes_messages():
    conv = Conversation(master_goal="test")
    agent = _TestAgent()
    agent._channel = AgentChannel(conv, agent.role)

    # Another agent posts a message to TestAgent
    ch2 = AgentChannel(conv, "OtherAgent")
    ch2.send("TestAgent", "request", {"question": "what is the status?"})

    task = Task(task_id="t99", goal="check status")
    messages = agent._build_prompt(task, conv)

    system_content = messages[0]["content"]
    assert "Inter-agent messages" in system_content
    assert "OtherAgent" in system_content
    assert "what is the status" in system_content


# ——————————————————————————————————————————————
# Test: SubAgent execute broadcasts result
# ——————————————————————————————————————————————


def test_subagent_execute_broadcasts_result():
    conv = Conversation(master_goal="test")

    class _ResultAgent(SubAgent):
        role = "ResultAgent"
        tools = []
        agentic_first = False

        def _run(self, task, conv):
            return "final answer", {}, [], []

    agent = _ResultAgent()
    task = Task(task_id="t100", goal="produce result")
    result = agent.execute(task, conv)

    assert result.success

    # Result should be broadcast via channel
    msgs = AgentChannel(conv, "ObserverAgent").receive()
    assert len(msgs) >= 1
    result_msg = [m for m in msgs if m.kind == "result"]
    assert len(result_msg) >= 1
    assert result_msg[0].payload["role"] == "ResultAgent"


# ——————————————————————————————————————————————
# Test: AgentRole compatibility
# ——————————————————————————————————————————————


def test_agent_role_includes_new_agent_fields():
    role = _TestAgent.get_role()
    assert role.name == "TestAgent"
    assert "calculate" in role.tools
    assert role.capabilities == []
    assert role.system_prompt


def test_agent_role_to_dict_roundtrip():
    role = _TestAgent.get_role()
    d = role.to_dict()
    role2 = AgentRole.from_dict(d)
    assert role2.name == role.name
    assert role2.tools == role.tools


def test_master_cancel_active_propagates_to_running_dispatch(monkeypatch):
    from arforge.multiagent.master_agent import MasterAgent, TaskUnderstanding

    master = MasterAgent()
    master._recall_context = lambda _text: ""
    master._decompose = lambda _text, _understanding: [
        Task(task_id="slow", role="CoderAgent", goal="slow")
    ]
    started = threading.Event()

    def dispatch(_tasks, conversation):
        started.set()
        assert conversation._cancelled.wait(2)
        return [
            TaskResult(
                task_id="slow",
                role="CoderAgent",
                success=False,
                error="aborted: conversation cancelled",
            )
        ]

    master._dispatcher = SimpleNamespace(dispatch=dispatch)
    master._merger = SimpleNamespace(
        merge=lambda _conversation, _text: {"answer": "partial"}
    )
    monkeypatch.setattr(
        "arforge.multiagent.master_agent.save_conversation", lambda _conv: None
    )
    understanding = TaskUnderstanding(
        intent="work",
        complexity="complex",
        suggested_roles=["CoderAgent"],
        estimated_steps=3,
        needs_multiagent=True,
    )
    output = {}

    worker = threading.Thread(
        target=lambda: output.update(master._multi_agent_path("work", understanding)),
        daemon=True,
    )
    worker.start()
    assert started.wait(1)
    assert master.cancel_active("terminal interrupt") == 1
    worker.join(2)

    assert worker.is_alive() is False
    assert output["cancelled"] is True
    assert output["success"] is False
    assert output["cancel_reason"] == "terminal interrupt"
    assert master.cancel_active() == 0
