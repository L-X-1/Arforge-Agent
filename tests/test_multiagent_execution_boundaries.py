"""Regression coverage for multi-agent execution-boundary enforcement."""

from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from arforge.core.hooks import HookContext, HookEvent
from arforge.core.permission import PermissionMode, get_permission_manager, permission_scope
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.multiagent.dispatcher import TaskDispatcher
from arforge.multiagent.protocol import AgentRole, Conversation, Task, TaskResult
from arforge.multiagent.security import (
    check_path_write,
    role_scope,
    sandbox_hook,
    task_scope,
)
from arforge.multiagent.sub_agent import SubAgent
from arforge.tools.file_tools import get_workspace
from arforge.workspace_context import current_session_id, execution_scope


@pytest.fixture
def writer_role() -> AgentRole:
    return AgentRole(
        name="BoundaryWriter",
        description="test role",
        capabilities=["safe_modify", "command_execution"],
        tools=["read_file", "write_file", "edit_file", "run_cmd"],
    )


@pytest.fixture(autouse=True)
def isolate_multiagent_audit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "arforge-home"))


def _tool_context(name: str, **args) -> HookContext:
    return HookContext(HookEvent.PRE_TOOL_USE, tool_name=name, tool_args=args)


def test_cancelled_task_blocks_follow_on_tool_calls(writer_role: AgentRole, tmp_path: Path) -> None:
    conversation = Conversation(master_goal="boundary test")
    task = Task(task_id="cancelled-task", role=writer_role.name, goal="write")
    conversation.reset_task_cancellation(task.task_id)

    with role_scope(writer_role), task_scope(
        conversation,
        task.task_id,
        workspace=tmp_path,
        constraints=task.constraints,
    ):
        conversation.cancel_task(task.task_id, "user requested cancellation")
        decision = sandbox_hook(_tool_context("write_file", filename="after-stop.txt"))

    assert decision.action == "block"
    assert "cancelled" in decision.reason


def test_task_constraints_are_enforced_before_workspace_mutation(
    writer_role: AgentRole, tmp_path: Path
) -> None:
    conversation = Conversation(master_goal="read only review")
    task = Task(
        task_id="readonly-task",
        role=writer_role.name,
        goal="review",
        constraints=["no file writes", "read-only"],
    )

    with role_scope(writer_role), task_scope(
        conversation,
        task.task_id,
        workspace=tmp_path,
        constraints=task.constraints,
    ):
        write_decision = sandbox_hook(_tool_context("edit_file", filename="review.py"))
        command_decision = sandbox_hook(_tool_context("run_cmd", command="python -V"))

    assert write_decision.action == "block"
    assert "read-only" in write_decision.reason
    assert command_decision.action == "block"
    assert "read-only" in command_decision.reason


def test_role_tool_whitelist_is_checked_at_execution_boundary(tmp_path: Path) -> None:
    role = AgentRole(
        name="Reader",
        description="test role",
        capabilities=["command_execution"],
        tools=["read_file"],
    )
    conversation = Conversation(master_goal="inspect")

    with role_scope(role), task_scope(conversation, "read-task", workspace=tmp_path):
        decision = sandbox_hook(_tool_context("run_cmd", command="python -V"))

    assert decision.action == "block"
    assert "not permitted" in decision.reason


class _ReadOnlyToolAgent(SubAgent):
    role = "ReadOnlyToolAgent"
    capabilities = ["command_execution"]
    tools = ["read_file"]


class _ScriptedToolAdapter:
    model_name = "test-model"

    def __init__(self) -> None:
        self._responses = [
            ToolCallResponse(
                content="",
                finish_reason="tool_calls",
                tool_calls=[ToolCall("unexpected", "run_cmd", '{"command":"python -V"}')],
            ),
            ToolCallResponse(content="done", finish_reason="stop", tool_calls=[]),
        ]
        self._index = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kwargs):
        response = self._responses[min(self._index, len(self._responses) - 1)]
        self._index += 1
        return response


def test_role_whitelist_blocks_an_unadvertised_model_tool_call() -> None:
    adapter = _ScriptedToolAdapter()
    agent = _ReadOnlyToolAgent(SimpleNamespace(agent=SimpleNamespace(adapter=adapter)))

    result = agent.run_agentic_task(Task(task_id="unexpected-tool", goal="inspect"), None, max_steps=3)

    blocked = [
        call
        for call in result.tool_calls
        if call["tool"] == "run_cmd" and not call["success"]
    ]
    assert blocked


def test_scoped_workspace_handles_relative_paths_and_rejects_siblings(
    writer_role: AgentRole, tmp_path: Path
) -> None:
    conversation = Conversation(master_goal="workspace boundary")

    with role_scope(writer_role), task_scope(conversation, "workspace-task", workspace=tmp_path):
        assert check_path_write(writer_role, "nested/output.txt") is True
        assert check_path_write(writer_role, tmp_path.parent / "sibling" / "output.txt") is False


class _ContextRecordingAgent:
    def __init__(self, observed: list[tuple[str, Path, str | None]]):
        self._observed = observed

    def execute(self, task: Task, conversation: Conversation) -> TaskResult:
        mode = get_permission_manager().get_mode()
        self._observed.append(
            (current_session_id(), get_workspace(), getattr(mode, "value", None))
        )
        return TaskResult(task_id=task.task_id, role=task.role, success=True, output="ok")


class _ContextRecordingPool:
    def __init__(self, observed: list[tuple[str, Path, str | None]]):
        self._observed = observed

    def create_agent(self, role: str, master=None) -> _ContextRecordingAgent:
        return _ContextRecordingAgent(self._observed)


def test_parallel_dispatch_propagates_workspace_and_session_context(tmp_path: Path) -> None:
    observed: list[tuple[str, Path, str | None]] = []
    dispatcher = TaskDispatcher(max_parallel=2, max_retries=0)
    dispatcher._pool = _ContextRecordingPool(observed)
    conversation = Conversation(master_goal="parallel context")
    tasks = [
        Task(task_id="context-a", role="ContextAgent", goal="a", deadline_ms=1_000),
        Task(task_id="context-b", role="ContextAgent", goal="b", deadline_ms=1_000),
    ]

    with execution_scope("boundary-session", workspace=tmp_path), permission_scope(PermissionMode.PLAN):
        results = dispatcher.dispatch(tasks, conversation)

    assert [result.success for result in results] == [True, True]
    assert observed == [
        ("boundary-session", tmp_path.resolve(), "plan"),
        ("boundary-session", tmp_path.resolve(), "plan"),
    ]


class _BlockingAgent:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0

    def execute(self, task: Task, conversation: Conversation) -> TaskResult:
        self.calls += 1
        self.started.set()
        self.release.wait(timeout=5)
        return TaskResult(task_id=task.task_id, role=task.role, success=True, output="late")


class _BlockingPool:
    def __init__(self, agent: _BlockingAgent):
        self._agent = agent

    def create_agent(self, role: str, master=None) -> _BlockingAgent:
        return self._agent


def test_dispatcher_returns_when_an_individual_task_is_cancelled() -> None:
    agent = _BlockingAgent()
    dispatcher = TaskDispatcher(max_retries=2)
    dispatcher._pool = _BlockingPool(agent)
    conversation = Conversation(master_goal="cancellation")
    task = Task(task_id="individual-cancel", role="BlockingAgent", goal="wait", deadline_ms=5_000)
    result_holder: list[TaskResult] = []

    thread = threading.Thread(
        target=lambda: result_holder.append(dispatcher._execute_one(task, conversation)),
        daemon=True,
    )
    thread.start()
    assert agent.started.wait(timeout=1)
    conversation.cancel_task(task.task_id, "cancel one task")
    thread.join(timeout=2)
    agent.release.set()

    assert not thread.is_alive()
    assert len(result_holder) == 1
    assert result_holder[0].success is False
    assert "cancelled" in result_holder[0].error
    assert agent.calls == 1


class _ExplodingAgent(SubAgent):
    role = "ExplodingAgent"
    tools = ["read_file"]

    def run_agentic_task(self, task: Task, conversation: Conversation, max_steps: int = 6):
        raise RuntimeError("adapter unavailable")


def test_agentic_execution_errors_are_returned_as_task_results() -> None:
    task = Task(task_id="exploding-task", role="ExplodingAgent", goal="inspect")
    result = _ExplodingAgent().execute(task, Conversation(master_goal="inspect"))

    assert result.success is False
    assert result.task_id == task.task_id
    assert "RuntimeError: adapter unavailable" in result.error
