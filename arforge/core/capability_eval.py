"""Deterministic capability evals for agent infrastructure.

These evals do not call a model. They verify the local contracts that make the
agent enterprise-usable: resume artifacts, impacted-test selection, live
interrupts, danger guards and replay diagnostics.
"""

from __future__ import annotations

import os
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from arforge.eval.report import EvalCase, EvalReport


@dataclass(frozen=True)
class CapabilityEvalTask:
    id: str
    category: str
    run: Callable[[Path], tuple[bool, str]]

    @property
    def migration_contract(self) -> dict[str, object]:
        """Stable manifest fields consumed by the TS migration harness."""
        return {
            "objective": (
                f"验证 capability-eval {self.id} ({self.category})：执行本地确定性基础设施合同，"
                "必须通过且不调用模型。"
            ),
            "source": f"arforge/core/capability_eval.py::{self.id}",
            "path": "arforge/core/capability_eval.py",
            "content": f"CapabilityEvalTask id={self.id} category={self.category}\n",
            "tests": (
                f"run_capability_eval task={self.id}; assert success=true; "
                "assert model_invoked=false\n"
            ),
            "expected_files": ["capability-eval-report.json"],
            "timeout_steps": 1,
            "positive_assertions": ["task_passed"],
            "negative_assertions": ["model_invoked"],
        }


def builtin_capability_eval_tasks() -> list[CapabilityEvalTask]:
    return [
        CapabilityEvalTask("g6-resume-artifacts", "resume", _eval_resume_artifacts),
        CapabilityEvalTask("g11-impacted-tests", "regression", _eval_impacted_tests),
        CapabilityEvalTask(
            "g13-interrupt-control-file", "interrupt", _eval_interrupt_control_file
        ),
        CapabilityEvalTask("g19-danger-guard", "security", _eval_danger_guard),
        CapabilityEvalTask("g20-replay-report", "replay", _eval_replay_report),
        CapabilityEvalTask(
            "ma1-hard-timeout", "multiagent", _eval_multiagent_hard_timeout
        ),
        CapabilityEvalTask(
            "ma2-progress-cancel", "multiagent", _eval_multiagent_progress_cancel
        ),
        CapabilityEvalTask(
            "ma3-role-boundaries", "multiagent", _eval_multiagent_role_boundaries
        ),
        CapabilityEvalTask(
            "ma4-unified-worker-runtime", "multiagent", _eval_unified_worker_runtime
        ),
        CapabilityEvalTask(
            "pr1-thinking-tool-choice", "provider", _eval_thinking_tool_choice
        ),
        CapabilityEvalTask("rd1-package-version", "readiness", _eval_package_version),
        CapabilityEvalTask(
            "ci1-quality-workflow", "automation", _eval_quality_workflow
        ),
        CapabilityEvalTask(
            "ob1-telemetry-isolation", "observability", _eval_telemetry_isolation
        ),
        CapabilityEvalTask(
            "sc0-created-test-order", "self_correct", _eval_created_test_order
        ),
        CapabilityEvalTask(
            "sc1-failure-feedback", "self_correct", _eval_self_correct_failure_feedback
        ),
        CapabilityEvalTask(
            "sc2-repeat-call-block", "self_correct", _eval_self_correct_repeat_block
        ),
        CapabilityEvalTask(
            "sc3-syntax-reflection",
            "self_correct",
            _eval_self_correct_syntax_reflection,
        ),
        CapabilityEvalTask(
            "sc4-tool-message-order",
            "self_correct",
            _eval_self_correct_tool_message_order,
        ),
        CapabilityEvalTask(
            "sc5-unexecuted-tool-text-block",
            "self_correct",
            _eval_self_correct_unexecuted_tool_text_block,
        ),
        CapabilityEvalTask(
            "sc6-cleanup-tool-switch",
            "self_correct",
            _eval_self_correct_cleanup_tool_switch,
        ),
        CapabilityEvalTask(
            "sc7-verification-gate",
            "self_correct",
            _eval_self_correct_verification_gate,
        ),
        CapabilityEvalTask(
            "sc8-post-edit-consistency",
            "self_correct",
            _eval_self_correct_post_edit_consistency,
        ),
        CapabilityEvalTask(
            "sc9-test-fix-loop", "self_correct", _eval_self_correct_test_fix_loop
        ),
        CapabilityEvalTask(
            "sc10-cross-file-imports",
            "self_correct",
            _eval_self_correct_cross_file_imports,
        ),
        CapabilityEvalTask(
            "sc11-transient-retry", "self_correct", _eval_self_correct_transient_retry
        ),
        CapabilityEvalTask(
            "sc12-auto-test-loop", "self_correct", _eval_self_correct_auto_test_loop
        ),
    ]


def run_capability_eval(
    tasks: list[CapabilityEvalTask] | None = None,
    *,
    suite: str = "capabilities",
) -> EvalReport:
    selected = tasks or builtin_capability_eval_tasks()
    cases: list[EvalCase] = []
    passed = 0
    with tempfile.TemporaryDirectory(prefix="arforge_capability_eval_") as temp:
        root = Path(temp)
        for task in selected:
            started = time.perf_counter()
            try:
                ok, detail = task.run(root / task.id)
                error = None if ok else detail
            except Exception as exc:  # noqa: BLE001 - eval reports failures, not crashes
                ok = False
                detail = ""
                error = f"{type(exc).__name__}: {exc}"
            if ok:
                passed += 1
            cases.append(
                EvalCase(
                    task_id=task.id,
                    category=task.category,
                    success=ok,
                    steps=1,
                    tokens=0,
                    error=error,
                    answer=detail[:500],
                )
            )
            cases[-1].elapsed_sec = round(time.perf_counter() - started, 3)  # type: ignore[attr-defined]
    total = len(selected)
    success_rate = passed / total if total else 0.0
    return EvalReport(
        suite=suite,
        cases=cases,
        total=total,
        passed=passed,
        success_rate=round(success_rate, 3),
        avg_score=round(success_rate, 3),
        total_tokens=0,
        total_cost_cny=0.0,
    )


def format_capability_eval_report(report: EvalReport) -> str:
    lines = [
        "Infrastructure contract evaluation (no model or autonomous project run)",
        f"Contracts: {report.passed}/{report.total} passed ({report.success_rate:.0%})",
    ]
    for case in report.cases:
        status = "PASS" if case.success else "FAIL"
        suffix = f" — {case.error}" if case.error else ""
        lines.append(f"- {status} [{case.category}] {case.task_id}{suffix}")
    return "\n".join(lines)


def self_correct_eval_tasks() -> list[CapabilityEvalTask]:
    """Return deterministic evals focused on failure recovery behavior."""
    return [
        task
        for task in builtin_capability_eval_tasks()
        if task.category == "self_correct"
    ]


def report_to_dict(report: EvalReport) -> dict:
    return {
        "suite": report.suite,
        "evaluation_mode": "deterministic_component_contracts",
        "model_invoked": False,
        "autonomous_project_validated": False,
        "scope": (
            "Local infrastructure contracts only; use `arforge eval` for model-driven "
            "isolated workspace tasks and a supervised project scenario for release acceptance."
        ),
        "total": report.total,
        "passed": report.passed,
        "success_rate": report.success_rate,
        "avg_score": report.avg_score,
        "total_tokens": report.total_tokens,
        "total_cost_cny": report.total_cost_cny,
        "cases": [
            {
                "task_id": case.task_id,
                "category": case.category,
                "success": case.success,
                "steps": case.steps,
                "tokens": case.tokens,
                "error": case.error,
                "judge_reason": case.judge_reason,
                "answer": case.answer,
            }
            for case in report.cases
        ],
    }


def _eval_resume_artifacts(root: Path) -> tuple[bool, str]:
    from arforge.core.run_transaction import load_run_messages, save_run_messages

    with _isolated_home(root):
        run_id = "cap-resume-001"
        messages = [{"role": "user", "content": "resume me"}]
        saved = save_run_messages(run_id, messages)
        loaded = load_run_messages(run_id)
        ok = saved.is_file() and loaded == messages
        return ok, f"messages={len(loaded)} path={saved.name}"


def _eval_impacted_tests(root: Path) -> tuple[bool, str]:
    from arforge.core.regression import locate_impacted_tests, run_pytest

    workspace = root / "workspace"
    tests = workspace / "tests"
    tests.mkdir(parents=True, exist_ok=True)
    (workspace / "foo.py").write_text(
        "def add(a, b):\n    return a + b\n", encoding="utf-8"
    )
    (tests / "test_foo.py").write_text(
        "from foo import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        encoding="utf-8",
    )
    impacted = locate_impacted_tests(["foo.py"], workspace)
    result = run_pytest(impacted, workspace)
    ok = (
        len(impacted) == 1
        and result["ran"]
        and result["returncode"] == 0
        and result["passed"] >= 1
    )
    return ok, f"impacted={len(impacted)} summary={result['summary']}"


def _eval_interrupt_control_file(root: Path) -> tuple[bool, str]:
    from arforge.core.hooks import (
        HookContext,
        HookEvent,
        get_hook_manager,
        reset_hook_manager,
    )
    from arforge.core.interrupt import (
        get_interrupt_state,
        install_interrupt_hook,
        reset_interrupt_state,
        start_interrupt_control_file,
    )

    reset_hook_manager()
    reset_interrupt_state()
    install_interrupt_hook()
    control = root / "control.txt"
    watcher = start_interrupt_control_file(control, poll_interval=0.05)
    try:
        with control.open("a", encoding="utf-8") as handle:
            handle.write("instruction: inspect tests first\n")
        deadline = time.time() + 2
        while time.time() < deadline and not get_interrupt_state().has_instructions():
            time.sleep(0.02)
        ctx = HookContext(
            HookEvent.PRE_LLM_CALL, messages=[{"role": "system", "content": "x"}]
        )
        decision = get_hook_manager().fire(ctx)
        injected = bool(
            ctx.messages and "inspect tests first" in ctx.messages[-1]["content"]
        )
        ok = decision.action == "modify" and injected
        return ok, f"decision={decision.action} injected={injected}"
    finally:
        watcher.stop()


def _eval_danger_guard(root: Path) -> tuple[bool, str]:
    from arforge.tools.basic_tools import run_command_no_shell

    dangerous = run_command_no_shell("git push --force origin main")
    safe = run_command_no_shell(["python", "--version"])
    ok = dangerous["returncode"] == 126 and safe["returncode"] == 0
    return ok, f"danger={dangerous['returncode']} safe={safe['returncode']}"


def _eval_replay_report(root: Path) -> tuple[bool, str]:
    from arforge.core.run_transaction import (
        build_run_report,
        save_run_messages,
        save_run_trace,
    )

    with _isolated_home(root):
        run_id = "cap-replay-001"
        save_run_messages(run_id, [{"role": "user", "content": "do it"}])
        save_run_trace(
            run_id,
            [{"step": 1, "event": "tool", "tool": "write_file", "success": True}],
            {"summary": {"tool_calls": 1, "total_tokens": 12}},
            "done",
        )
        report = build_run_report(run_id)
        ok = (
            report["has_trace"]
            and report["has_messages"]
            and report["trace_events"] == 1
            and report["answer"] == "done"
        )
        return (
            ok,
            f"trace_events={report['trace_events']} messages={report['messages_count']}",
        )


def _eval_multiagent_hard_timeout(root: Path) -> tuple[bool, str]:
    """Prove that a blocking worker cannot turn a deadline into a hidden wait."""
    from types import SimpleNamespace

    from arforge.multiagent.dispatcher import DispatchConfig, TaskDispatcher
    from arforge.multiagent.protocol import Conversation, Task, TaskResult

    calls = 0
    returned = 0

    class BlockingAgent:
        def execute(self, task, _conversation):
            nonlocal calls
            calls += 1
            time.sleep(0.4)
            return TaskResult(
                task_id=task.task_id,
                role=task.role,
                success=True,
                output="late",
            )

    def return_agent(_role, _agent):
        nonlocal returned
        returned += 1

    dispatcher = TaskDispatcher(
        config=DispatchConfig(max_retries=2, timeout_grace_ms=0)
    )
    dispatcher._pool = SimpleNamespace(
        borrow_agent=lambda _role: BlockingAgent(),
        create_agent=lambda _role: BlockingAgent(),
        return_agent=return_agent,
    )
    conversation = Conversation(master_goal="bounded eval")
    task = Task(
        task_id="bounded",
        role="CoderAgent",
        goal="block",
        deadline_ms=30,
    )

    started = time.perf_counter()
    result = dispatcher._execute_one(task, conversation)
    elapsed = time.perf_counter() - started
    ok = (
        not result.success
        and "timeout" in result.error
        and elapsed < 0.25
        and calls == 1
        and returned == 0
        and conversation.task_cancelled(task.task_id)
    )
    return ok, f"elapsed={elapsed:.3f}s calls={calls} repooled={returned}"


def _eval_multiagent_progress_cancel(root: Path) -> tuple[bool, str]:
    """Prove that progress and task cancellation cross the public protocol."""
    from arforge.multiagent.protocol import Conversation

    events: list[str] = []
    conversation = Conversation(master_goal="observable eval")
    conversation.set_progress_callback(lambda event, _data: events.append(event))
    conversation.emit_progress("phase_start", phase="dispatch")
    conversation.reset_task_cancellation("task-1")
    conversation.cancel_task("task-1", "eval deadline")
    conversation.cancel("eval stop")

    ok = (
        events
        == [
            "phase_start",
            "task_cancel_requested",
            "conversation_cancelled",
        ]
        and conversation.task_cancelled("task-1")
        and conversation.get_shared("_cancel_reason") == "eval stop"
    )
    return ok, f"events={events} cancelled={conversation.cancelled}"


def _eval_multiagent_role_boundaries(root: Path) -> tuple[bool, str]:
    """Keep the lightweight Task roles aligned with graph-orchestrator roles.

    The two runtimes have different lifecycles, but their public role names and
    least-privilege boundary must not silently drift apart.
    """
    from arforge.core.subagent import (
        get_subagent_role_spec,
        list_subagent_roles,
        orchestrator_subagent_role_specs,
    )
    from arforge.multiagent.sub_agent_pool import SubAgentPool

    lightweight = {item["role"]: item for item in list_subagent_roles()}
    pool = SubAgentPool.instance()
    orchestrator = pool.list_role_names()
    expected = {
        name.removesuffix("Agent").casefold()
        for name in orchestrator
        if name.endswith("Agent")
    }
    missing = sorted(expected - set(lightweight))
    unsafe_read_roles = sorted(
        role
        for role, item in lightweight.items()
        if item["category"] == "read"
        and any(
            tool in {"write_file", "edit_file", "run_cmd", "run_tests"}
            for tool in item["tools"]
        )
    )
    drift: list[str] = []
    for spec in orchestrator_subagent_role_specs():
        role_name = spec.orchestrator_role or ""
        agent = pool.create_agent(role_name)
        if get_subagent_role_spec(role_name) is not spec:
            drift.append(f"{role_name}:alias")
        if agent is None:
            drift.append(f"{role_name}:missing-agent")
            continue
        if tuple(agent.tools) != spec.tools:
            drift.append(f"{role_name}:tools")
        if tuple(agent.capabilities) != spec.capabilities:
            drift.append(f"{role_name}:capabilities")
        if agent.system_prompt != spec.system_prompt:
            drift.append(f"{role_name}:prompt")
        if agent.max_steps != spec.max_steps:
            drift.append(f"{role_name}:steps")
    ok = not missing and not unsafe_read_roles and not drift
    return ok, (
        f"orchestrator={len(orchestrator)} lightweight={len(lightweight)} "
        f"missing={missing} unsafe={unsafe_read_roles} drift={drift}"
    )


def _eval_unified_worker_runtime(root: Path) -> tuple[bool, str]:
    """Both public front doors must launch the same worker-loop function."""
    import inspect

    from arforge.core.subagent import run_subagent
    from arforge.multiagent.sub_agent import SubAgent

    lightweight_shared = "execute_subagent_loop(" in inspect.getsource(run_subagent)
    orchestrator_shared = "execute_subagent_loop(" in inspect.getsource(
        SubAgent.run_agentic_task
    )
    ok = lightweight_shared and orchestrator_shared
    return ok, (
        f"lightweight_shared={lightweight_shared} "
        f"orchestrator_shared={orchestrator_shared}"
    )


def _eval_thinking_tool_choice(root: Path) -> tuple[bool, str]:
    """Exercise the provider request boundary that previously returned HTTP 400."""
    from types import SimpleNamespace

    from arforge.models.deepseek_adapter import DeepSeekAdapter

    calls: list[dict] = []

    class Completions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                usage=None,
                choices=[
                    SimpleNamespace(
                        finish_reason="stop",
                        message=SimpleNamespace(content="ok", tool_calls=[]),
                    )
                ],
            )

    adapter = DeepSeekAdapter(api_key="eval-key", model="deepseek-v4-flash")
    adapter.client = SimpleNamespace(chat=SimpleNamespace(completions=Completions()))
    adapter.generate_with_tools(
        [{"role": "user", "content": "run tests"}],
        tools=[{"type": "function", "function": {"name": "run_tests"}}],
        tool_choice={"type": "function", "function": {"name": "run_tests"}},
    )
    request = calls[-1]
    ok = (
        adapter.supports_forced_tool_choice is False
        and "tool_choice" not in request
        and request.get("extra_body") == {"thinking": {"type": "enabled"}}
    )
    return ok, f"forced={adapter.supports_forced_tool_choice} fields={sorted(request)}"


def _eval_package_version(root: Path) -> tuple[bool, str]:
    from arforge.product.doctor import _check_package_versions

    result = _check_package_versions()
    return result.ok, result.detail


def _eval_quality_workflow(root: Path) -> tuple[bool, str]:
    repository = Path(__file__).resolve().parents[2]
    workflow = repository / ".github" / "workflows" / "ci.yml"
    if not workflow.is_file():
        return False, "missing .github/workflows/ci.yml"
    text = workflow.read_text(encoding="utf-8")
    required = (
        "python -m ruff check arforge tests config.py main.py",
        "python -m pytest -q",
        "arforge capability-eval --json",
        "arforge doctor --json",
        "bun run lint",
        "bun run typecheck",
        "bun run brand:check",
    )
    missing = [command for command in required if command not in text]
    return not missing, f"workflow={workflow.name} missing={missing}"


def _eval_telemetry_isolation(root: Path) -> tuple[bool, str]:
    """A metrics-store outage must not turn a successful model call into failure."""
    from arforge.models import token_tracker

    original = token_tracker.get_session
    token_tracker.get_session = lambda: (_ for _ in ()).throw(
        UnicodeDecodeError("utf-8", b"\xd6", 0, 1, "invalid continuation byte")
    )
    try:
        recorded = token_tracker.record_token_usage(
            "capability-eval-model",
            prompt_tokens=1,
            completion_tokens=1,
        )
    finally:
        token_tracker.get_session = original
    return recorded is False, f"recorded={recorded} primary_path_survived=True"


def _eval_created_test_order(root: Path) -> tuple[bool, str]:
    """Do not force-run a regression test that the task first asks us to create."""
    from arforge.core.agentic import (
        _explicit_tool_requests,
        _runnable_test_targets_from_task,
    )

    task = (
        "新增 tests/test_regression.py 覆盖循环依赖，最后运行 "
        "tests/test_regression.py 并确认通过。"
    )
    tools = [
        {
            "type": "function",
            "function": {"name": "run_tests", "parameters": {"type": "object"}},
        }
    ]
    targets = _runnable_test_targets_from_task(task)
    requested = _explicit_tool_requests(task, tools)
    ok = targets == [] and "run_tests" not in requested
    return ok, f"premature_targets={targets} explicit={requested}"


class _EvalToolCall:
    def __init__(self, call_id: str, name: str, arguments: str):
        self.id = call_id
        self.name = name
        self.arguments = arguments


class _EvalResponse:
    def __init__(self, content: str = "", tool_calls=None, usage=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage = usage or {}


class _EvalAdapter:
    model_name = "capability-self-correct"

    def __init__(self, script):
        self.script = script
        self.idx = 0
        self.messages_seen: list[list[dict]] = []

    def generate_with_tools(self, messages, tools=None, tool_choice="auto"):
        self.messages_seen.append([dict(item) for item in messages])
        response = self.script[min(self.idx, len(self.script) - 1)]
        self.idx += 1
        if callable(response):
            return response(messages)
        return response


def _eval_self_correct_failure_feedback(root: Path) -> tuple[bool, str]:
    from arforge.core.agentic import run_tool_loop
    from arforge.tool_registry import ToolResult

    def second_turn(messages):
        joined = "\n".join(str(item.get("content", "")) for item in messages)
        if (
            "Tool failure recovery required" not in joined
            or "Before your next tool call" not in joined
        ):
            return _EvalResponse("missing feedback")
        return _EvalResponse(
            "", [_EvalToolCall("c2", "run_cmd", '{"command":"python -m pytest -q"}')]
        )

    adapter = _EvalAdapter(
        [
            _EvalResponse(
                "", [_EvalToolCall("c1", "run_cmd", '{"command":"pytest -q"}')]
            ),
            second_turn,
            _EvalResponse("recovered"),
        ]
    )
    executed: list[str] = []

    def executor(name: str, args: dict) -> ToolResult:
        executed.append(args["command"])
        if args["command"] == "pytest -q":
            return ToolResult(
                name,
                False,
                "",
                "command returned non-zero exit code 1: pytest not found",
            )
        return ToolResult(name, True, "1 passed", "")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "fix failing tests"}],
        tools=[],
        max_steps=5,
        executor=executor,
    )
    ok = result.answer == "recovered" and executed == [
        "pytest -q",
        "python -m pytest -q",
    ]
    return ok, f"executed={executed} answer={result.answer}"


def _eval_self_correct_repeat_block(root: Path) -> tuple[bool, str]:
    from arforge.core.agentic import run_tool_loop
    from arforge.tool_registry import ToolResult

    adapter = _EvalAdapter(
        [
            _EvalResponse(
                "", [_EvalToolCall("c1", "run_cmd", '{"command":"pytest -q"}')]
            ),
            _EvalResponse(
                "", [_EvalToolCall("c2", "run_cmd", '{"command":"pytest -q"}')]
            ),
            _EvalResponse("repeat stopped"),
        ]
    )
    executed = 0

    def executor(name: str, args: dict) -> ToolResult:
        nonlocal executed
        executed += 1
        return ToolResult(name, False, "", "command returned non-zero exit code 1")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "fix failing tests"}],
        tools=[],
        max_steps=5,
        executor=executor,
    )
    events = {item.get("event") for item in result.trace}
    ok = executed == 1 and "self_correct_repeat_blocked" in events
    return ok, f"executed={executed} events={sorted(events)}"


def _eval_self_correct_syntax_reflection(root: Path) -> tuple[bool, str]:
    from arforge.core.self_correct import SelfCorrectState

    state = SelfCorrectState()
    state.record(
        error_text="SyntaxError: invalid syntax at line 1", tool_name="run_cmd", step=1
    )
    state.record(
        error_text="SyntaxError: unexpected indent at line 2",
        tool_name="run_cmd",
        step=2,
    )
    reflection = state.reflection_needed(current_step=3) or ""
    ok = "SYNTAX" in reflection and "Do NOT retry the same fix" in reflection
    return ok, reflection[:180]


def _eval_self_correct_tool_message_order(root: Path) -> tuple[bool, str]:
    from arforge.core.agentic import run_tool_loop
    from arforge.tool_registry import ToolResult

    roles_seen: list[str] = []

    def second_turn(messages):
        assistant_index = next(
            i for i, item in enumerate(messages) if item.get("role") == "assistant"
        )
        if not roles_seen:
            roles_seen.extend(
                item.get("role", "")
                for item in messages[assistant_index + 1 : assistant_index + 4]
            )
        return _EvalResponse("ordered")

    adapter = _EvalAdapter(
        [
            _EvalResponse(
                "",
                [
                    _EvalToolCall("c1", "run_cmd", '{"command":"pytest -q"}'),
                    _EvalToolCall("c2", "read_file", '{"filename":"README.md"}'),
                ],
            ),
            second_turn,
        ]
    )

    def executor(name: str, args: dict) -> ToolResult:
        if name == "run_cmd":
            return ToolResult(name, False, "", "command returned non-zero exit code 1")
        return ToolResult(name, True, "content", "")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "fix failing tests"}],
        tools=[],
        max_steps=3,
        executor=executor,
    )
    ok = result.answer == "ordered" and roles_seen == ["tool", "tool", "user"]
    return ok, f"roles={roles_seen}"


def _eval_self_correct_unexecuted_tool_text_block(root: Path) -> tuple[bool, str]:
    from arforge.core.agentic import run_tool_loop
    from arforge.tool_registry import ToolResult

    adapter = _EvalAdapter(
        [
            _EvalResponse(
                '<tool_calls><invoke name="write_file"></invoke></tool_calls>'
            ),
            _EvalResponse(
                "",
                [
                    _EvalToolCall(
                        "c1",
                        "write_file",
                        '{"filename":"ABC.txt","content":"hello，world"}',
                    )
                ],
            ),
            _EvalResponse("completed after real tool call"),
        ]
    )
    executed: list[str] = []

    def executor(name: str, args: dict) -> ToolResult:
        executed.append(f"{name}:{args.get('filename', '')}:{args.get('content', '')}")
        return ToolResult(name, True, "wrote ABC.txt", "")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "write ABC.txt"}],
        tools=[],
        max_steps=5,
        executor=executor,
    )
    events = {item.get("event") for item in result.trace}
    ok = (
        result.answer == "completed after real tool call"
        and executed == ["write_file:ABC.txt:hello，world"]
        and "unexecuted_tool_text_blocked" in events
    )
    return ok, f"executed={executed} events={sorted(events)}"


def _eval_self_correct_cleanup_tool_switch(root: Path) -> tuple[bool, str]:
    from arforge.core.agentic import run_tool_loop
    from arforge.tool_registry import ToolResult

    def second_turn(messages):
        joined = "\n".join(str(item.get("content", "")) for item in messages)
        if "Tool failure recovery required" not in joined:
            return _EvalResponse("missing cleanup feedback")
        return _EvalResponse(
            "", [_EvalToolCall("c2", "delete_file", '{"filename":"_verify_abc.py"}')]
        )

    adapter = _EvalAdapter(
        [
            _EvalResponse(
                "",
                [
                    _EvalToolCall(
                        "c1",
                        "run_cmd",
                        '{"command":"python -c \\"import sys; sys.exit(1)\\""}',
                    )
                ],
            ),
            second_turn,
            _EvalResponse("temporary helper removed"),
            _EvalResponse("", [_EvalToolCall("c3", "verify_work", "{}")]),
            _EvalResponse("temporary helper removed and verified"),
        ]
    )
    executed: list[str] = []

    def executor(name: str, args: dict) -> ToolResult:
        executed.append(f"{name}:{args.get('command') or args.get('filename')}")
        if name == "run_cmd":
            return ToolResult(name, False, "", "command returned non-zero exit code 1")
        return ToolResult(name, True, "deleted _verify_abc.py", "")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "clean up temporary helper"}],
        tools=[],
        max_steps=5,
        executor=executor,
    )
    events = {item.get("event") for item in result.trace}
    ok = (
        result.answer == "temporary helper removed and verified"
        and executed
        == [
            'run_cmd:python -c "import sys; sys.exit(1)"',
            "delete_file:_verify_abc.py",
            "verify_work:None",
        ]
        and "self_correct_feedback" in events
        and any(
            call.get("tool") == "run_cmd" and not call.get("success")
            for call in result.tool_calls
        )
    )
    return ok, f"executed={executed} events={sorted(events)} answer={result.answer}"


def _eval_self_correct_verification_gate(root: Path) -> tuple[bool, str]:
    from arforge.core.agentic import run_tool_loop
    from arforge.tool_registry import ToolResult

    adapter = _EvalAdapter(
        [
            _EvalResponse(
                "",
                [
                    _EvalToolCall(
                        "c1", "write_file", '{"filename":"x.py","content":"print(1)"}'
                    )
                ],
            ),
            _EvalResponse("all done"),
            _EvalResponse("", [_EvalToolCall("c2", "verify_work", "{}")]),
            _EvalResponse("verified, done"),
        ]
    )

    def executor(name: str, args: dict) -> ToolResult:
        return ToolResult(name, True, "ok", "")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "create x.py"}],
        tools=[],
        max_steps=5,
        executor=executor,
    )
    events = {item.get("event") for item in result.trace}
    ok = (
        result.answer == "verified, done"
        and "final_answer_verification_required" in events
        and "final" in events  # normal final after verification
    )
    return ok, f"events={sorted(events)} answer={result.answer[:60]}"


def _eval_self_correct_test_fix_loop(root: Path) -> tuple[bool, str]:
    """sc9: test failure parsing extracts file/line/expected/actual from pytest output."""
    from arforge.core.self_correct import parse_test_failures, build_test_fix_feedback

    fake_output = """============================= test session starts ==============================
test_math.py::test_add FAILED
test_math.py::test_sub PASSED

=================================== FAILURES ===================================
__________________________ test_add __________________________

    def test_add():
>       assert add(2, 3) == 6
E       assert 5 == 6
E        +  where 5 = add(2, 3)

test_math.py:4: AssertionError
========================= short test summary info ==========================
FAILED test_math.py::test_add
1 failed, 1 passed
"""

    failures = parse_test_failures(fake_output)
    assert len(failures) == 1, f"Expected 1 failure, got {len(failures)}"
    f = failures[0]
    assert f.test_node == "test_add"
    assert f.file == "test_math.py"
    assert f.line == 4
    assert f.expected == "6"
    assert f.actual == "5"

    fb = build_test_fix_feedback(failures)
    assert "1 test(s) failed" in fb
    assert "test_math.py:4" in fb
    assert "Expected: 6" in fb
    assert "Actual:   5" in fb
    assert "Fix all failures" in fb

    # Empty output returns empty list
    assert parse_test_failures("") == []
    assert parse_test_failures("all tests passed") == []

    return True, "parsed 1 failure with file/line/expected/actual"


def _eval_self_correct_post_edit_consistency(root: Path) -> tuple[bool, str]:
    """sc8: post-edit consistency check catches syntax errors in modified files."""
    from arforge.core.self_correct import (
        verify_edited_files,
        build_consistency_feedback,
    )

    root.mkdir(parents=True, exist_ok=True)

    # Create a Python file with a syntax error
    bad_file = root / "broken.py"
    bad_file.write_text("def foo():\n    return x +\n", encoding="utf-8")

    # Also create a valid file
    good_file = root / "valid.py"
    good_file.write_text("def bar():\n    return 42\n", encoding="utf-8")

    ok, issues = verify_edited_files([str(bad_file), str(good_file)], str(root))
    # Should NOT be all ok — broken.py has a syntax error
    assert not ok, "Expected syntax error in broken.py"
    assert len(issues) == 1, f"Expected 1 issue, got {issues}"
    assert "SyntaxError" in issues[0], f"Expected SyntaxError, got {issues[0]}"

    # Build feedback and verify it's actionable
    fb = build_consistency_feedback(issues)
    assert "Post-edit consistency check found issues" in fb
    assert "broken.py" in fb

    # Clean files => all ok
    bad_file.unlink()
    good_file.unlink()
    ok2, issues2 = verify_edited_files([], str(root))
    assert ok2 and not issues2

    return True, f"caught {len(issues)} syntax issue(s)"


def _eval_self_correct_cross_file_imports(root: Path) -> tuple[bool, str]:
    """sc10: cross-file import resolution catches unresolved imports."""
    from arforge.core.self_correct import verify_imports_resolve, verify_all_imports

    root.mkdir(parents=True, exist_ok=True)

    # Create a small package
    pkg = root / "mypkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text(
        "from mypkg.utils import helper\n", encoding="utf-8"
    )
    (pkg / "utils.py").write_text(
        "def helper() -> int:\n    return 42\n", encoding="utf-8"
    )

    # File with a valid import
    good = root / "good.py"
    good.write_text(
        "from mypkg.utils import helper\nprint(helper())\n", encoding="utf-8"
    )
    ok, issues = verify_imports_resolve(str(good), str(root))
    assert ok, f"good.py should pass: {issues}"

    # File with an invalid import (symbol does not exist)
    bad = root / "bad.py"
    bad.write_text("from mypkg.utils import nonexistent\n", encoding="utf-8")
    ok2, issues2 = verify_imports_resolve(str(bad), str(root))
    assert not ok2, "bad.py should fail"
    assert len(issues2) == 1
    assert "nonexistent" in issues2[0]

    # File importing a non-existent module
    bad2 = root / "bad2.py"
    bad2.write_text("import totally_missing_module\n", encoding="utf-8")
    ok3, issues3 = verify_imports_resolve(str(bad2), str(root))
    assert not ok3
    assert any("totally_missing_module" in i for i in issues3)

    # verify_all_imports aggregates correctly
    ok4, issues4 = verify_all_imports([str(good), str(bad), str(bad2)], str(root))
    assert not ok4
    assert len(issues4) >= 2  # at least the two broken ones

    return True, f"caught {len(issues4)} import issue(s)"


def _eval_self_correct_transient_retry(root: Path) -> tuple[bool, str]:
    """sc11: transient error detection and retry configuration."""
    from arforge.core.self_correct import is_transient, retry_config

    # Verify transient detection works
    assert is_transient("connection timed out after 30s")
    assert is_transient("rate limit exceeded, try again later")
    assert is_transient("503 Service Unavailable")
    assert is_transient("connection refused")
    assert not is_transient("SyntaxError: invalid syntax")
    assert not is_transient("NameError: name 'x' is not defined")

    # Verify retry config
    rc = retry_config()
    assert rc["max_retries"] == 5
    assert rc["base_delay_sec"] == 1.0
    assert rc["backoff_factor"] == 2.0
    assert rc["max_delay_sec"] == 30.0

    return True, "transient detection and retry config verified"


def _eval_self_correct_auto_test_loop(root: Path) -> tuple[bool, str]:
    """sc12: a parsed test failure, edit, and passing rerun complete the recovery loop."""
    from arforge.core.agentic import run_tool_loop
    from arforge.tool_registry import ToolResult

    failing_output = """test_math.py::test_add FAILED

=================================== FAILURES ===================================
____________________________ test_add ____________________________
>       assert add(2, 3) == 6
E       assert 5 == 6
test_math.py:4: AssertionError
1 failed
"""
    rerun_prompt_seen = False

    def request_rerun(messages):
        nonlocal rerun_prompt_seen
        joined = "\n".join(str(item.get("content", "")) for item in messages)
        rerun_prompt_seen = "Code changes applied. Re-run the tests now" in joined
        return _EvalResponse("", [_EvalToolCall("c3", "run_tests", "{}")])

    adapter = _EvalAdapter(
        [
            _EvalResponse("", [_EvalToolCall("c1", "run_tests", "{}")]),
            _EvalResponse(
                "",
                [
                    _EvalToolCall(
                        "c2",
                        "write_file",
                        '{"filename":"test_math.py","content":"def add(a, b):\\n    return a + b\\n"}',
                    )
                ],
            ),
            request_rerun,
            _EvalResponse("tests fixed and verified"),
        ]
    )
    test_runs = 0

    def executor(name: str, args: dict) -> ToolResult:
        nonlocal test_runs
        if name == "run_tests":
            test_runs += 1
            if test_runs == 1:
                return ToolResult(name, False, "", failing_output)
            return ToolResult(name, True, "1 passed", "")
        if name == "write_file":
            return ToolResult(name, True, f"wrote {args.get('filename', '')}", "")
        return ToolResult(name, False, "", f"unexpected tool: {name}")

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "fix failing tests"}],
        tools=[],
        max_steps=5,
        executor=executor,
    )
    events = {item.get("event") for item in result.trace}
    ok = (
        result.answer == "tests fixed and verified"
        and test_runs == 2
        and rerun_prompt_seen
        and "test_fix_feedback" in events
        and "auto_test_rerun_prompt" in events
        and "test_fix_resolved" in events
    )
    return (
        ok,
        f"test_runs={test_runs} rerun_prompt={rerun_prompt_seen} events={sorted(events)}",
    )


@contextmanager
def _isolated_home(root: Path):
    previous = os.environ.get("ARFORGE_HOME")
    home = root / ".arforge"
    os.environ["ARFORGE_HOME"] = str(home)
    try:
        yield home
    finally:
        if previous is None:
            os.environ.pop("ARFORGE_HOME", None)
        else:
            os.environ["ARFORGE_HOME"] = previous
