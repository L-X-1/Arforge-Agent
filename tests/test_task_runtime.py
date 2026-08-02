from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

import pytest

from arforge.bridge import dispatch
from arforge.product.action_runtime import ActionRuntime, ActionRuntimeError
from arforge.product.session_runtime import SessionRuntime
from arforge.product.task_runtime import TaskRuntime, TaskRuntimeError, TaskStore


class NoopAgent:
    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, _value: str):
        return iter(())


def _wait(tasks: TaskRuntime, session_id: str, task_id: str, statuses: set[str]) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        task = tasks.get_task(session_id, task_id)
        if task["status"] in statuses:
            return task
        time.sleep(0.005)
    raise AssertionError(f"task did not reach {statuses}")


def _approved_tool(actions: ActionRuntime, session_id: str, expression: str = "6*7") -> dict:
    prepared = actions.prepare_tool(session_id, "calculate", {"expression": expression})
    actions.respond_approval(session_id, prepared["approval_id"], "approve")
    return prepared


def test_async_tool_task_is_acknowledged_then_executes(tmp_path: Path):
    events: list[dict] = []
    actions = ActionRuntime(tmp_path)
    tasks = TaskRuntime(actions, events.append, TaskStore(tmp_path / "state" / "tasks.db"))
    prepared = _approved_tool(actions, "session-1")

    accepted = tasks.submit_tool("session-1", prepared["action_id"], prepared["approval_id"])
    assert accepted["status"] == "accepted"
    assert events == []

    tasks.release_task(accepted["task_id"])
    completed = _wait(tasks, "session-1", accepted["task_id"], {"succeeded"})
    deadline = time.monotonic() + 1
    while len(events) < 2 and time.monotonic() < deadline:
        time.sleep(0.005)

    assert completed["result"]["result"]["output"] == "42"
    assert [event["type"] for event in events] == ["task.started", "task.completed"]
    persisted = sqlite3.connect(tmp_path / "state" / "tasks.db").execute(
        "SELECT status, subject_id FROM bridge_tasks WHERE task_id = ?", (accepted["task_id"],)
    ).fetchone()
    assert persisted == ("succeeded", prepared["action_id"])


def test_cancel_before_release_prevents_tool_execution(tmp_path: Path):
    actions = ActionRuntime(tmp_path)
    tasks = TaskRuntime(actions, lambda _event: None, TaskStore(tmp_path / "tasks.db"))
    prepared = _approved_tool(actions, "session-1")
    accepted = tasks.submit_tool("session-1", prepared["action_id"], prepared["approval_id"])

    requested = tasks.cancel_task("session-1", accepted["task_id"])
    assert requested["status"] == "cancellation_requested"
    tasks.release_task(accepted["task_id"])
    cancelled = _wait(tasks, "session-1", accepted["task_id"], {"cancelled"})

    assert cancelled["side_effects_possible"] is False
    assert actions.get_tool_action("session-1", prepared["action_id"])["status"] == "prepared"


def test_running_cancel_is_honest_about_possible_side_effects(tmp_path: Path, monkeypatch):
    actions = ActionRuntime(tmp_path)
    entered = threading.Event()
    release = threading.Event()
    prepared = _approved_tool(actions, "session-1")
    original = actions.execute_tool

    def delayed(*args):
        entered.set()
        release.wait(2)
        return original(*args)

    monkeypatch.setattr(actions, "execute_tool", delayed)
    tasks = TaskRuntime(actions, lambda _event: None, TaskStore(tmp_path / "tasks.db"))
    accepted = tasks.submit_tool("session-1", prepared["action_id"], prepared["approval_id"])
    tasks.release_task(accepted["task_id"])
    assert entered.wait(1)

    cancelling = tasks.cancel_task("session-1", accepted["task_id"])
    assert cancelling["side_effects_possible"] is True
    release.set()
    cancelled = _wait(tasks, "session-1", accepted["task_id"], {"cancelled"})
    assert cancelled["side_effects_possible"] is True


def test_cancellation_wins_when_the_inflight_action_raises(tmp_path: Path, monkeypatch):
    """A requested cancellation must not be reclassified as an execution failure."""
    actions = ActionRuntime(tmp_path)
    entered = threading.Event()
    release = threading.Event()
    prepared = _approved_tool(actions, "session-1")

    def delayed_failure(*_args):
        entered.set()
        release.wait(2)
        raise ActionRuntimeError("BACKEND_ERROR", "simulated executor failure")

    monkeypatch.setattr(actions, "execute_tool", delayed_failure)
    tasks = TaskRuntime(actions, lambda _event: None, TaskStore(tmp_path / "tasks.db"))
    accepted = tasks.submit_tool("session-1", prepared["action_id"], prepared["approval_id"])
    tasks.release_task(accepted["task_id"])
    assert entered.wait(1)

    cancelling = tasks.cancel_task("session-1", accepted["task_id"])
    assert cancelling["status"] == "cancellation_requested"
    release.set()
    cancelled = _wait(tasks, "session-1", accepted["task_id"], {"cancelled"})

    assert cancelled["side_effects_possible"] is True
    assert cancelled["error"] is None


def test_event_delivery_failure_cannot_reclassify_a_completed_task(tmp_path: Path):
    """Bridge event delivery is best effort after task state has been committed."""
    actions = ActionRuntime(tmp_path)
    prepared = _approved_tool(actions, "session-1")
    completed_event_attempted = threading.Event()

    def emit(event: dict) -> None:
        if event["type"] == "task.completed":
            completed_event_attempted.set()
            raise RuntimeError("event consumer unavailable")

    store = TaskStore(tmp_path / "tasks.db")
    tasks = TaskRuntime(actions, emit, store)
    accepted = tasks.submit_tool("session-1", prepared["action_id"], prepared["approval_id"])
    tasks.release_task(accepted["task_id"])
    assert completed_event_attempted.wait(1)
    assert tasks._tasks[accepted["task_id"]].finished.wait(1)
    completed = tasks.get_task("session-1", accepted["task_id"])

    assert completed["result"]["status"] == "succeeded"
    with sqlite3.connect(store.path) as connection:
        persisted = connection.execute(
            "SELECT status FROM bridge_tasks WHERE task_id = ?", (accepted["task_id"],)
        ).fetchone()
    assert persisted == ("succeeded",)


def test_failed_task_retry_creates_fresh_approval(tmp_path: Path):
    actions = ActionRuntime(tmp_path)
    tasks = TaskRuntime(actions, lambda _event: None, TaskStore(tmp_path / "tasks.db"))
    prepared = _approved_tool(actions, "session-1", "1/0")
    accepted = tasks.submit_tool("session-1", prepared["action_id"], prepared["approval_id"])
    tasks.release_task(accepted["task_id"])
    failed = _wait(tasks, "session-1", accepted["task_id"], {"failed"})

    retry = tasks.retry_task("session-1", failed["task_id"])
    assert retry["action_id"] != prepared["action_id"]
    assert retry["approval_id"] != prepared["approval_id"]
    assert retry["approval"]["status"] == "pending"


def test_restart_marks_active_metadata_interrupted_without_payload(tmp_path: Path):
    store = TaskStore(tmp_path / "tasks.db")
    with sqlite3.connect(store.path) as connection:
        connection.execute(
            """
            INSERT INTO bridge_tasks
            (task_id, session_id, kind, subject_id, status, created_at, updated_at, side_effects_possible)
            VALUES ('task-1', 'session-1', 'tool.execute', 'action-1', 'running', 'a', 'a', 0)
            """
        )

    recovered = TaskRuntime(ActionRuntime(tmp_path), lambda _event: None, TaskStore(store.path))
    task = recovered.get_task("session-1", "task-1")

    assert task["status"] == "interrupted"
    assert task["recovered"] is True
    assert task["result_available"] is False
    assert task["side_effects_possible"] is True
    with pytest.raises(TaskRuntimeError) as caught:
        recovered.retry_task("session-1", "task-1")
    assert caught.value.code == "INVALID_STATE"


def test_bridge_exposes_task_methods_and_session_isolation(tmp_path: Path):
    runtime = SessionRuntime(lambda _event: None, agent_factory=NoopAgent)
    actions = ActionRuntime(tmp_path)
    tasks = TaskRuntime(actions, lambda _event: None, TaskStore(tmp_path / "tasks.db"))
    session_id = runtime.create_session()["session_id"]
    prepared = _approved_tool(actions, session_id)
    response = dispatch(
        {
            "version": "1.1",
            "method": "tool.execute_async",
            "params": {
                "session_id": session_id,
                "action_id": prepared["action_id"],
                "approval_id": prepared["approval_id"],
            },
        },
        runtime=runtime,
        actions=actions,
        tasks=tasks,
    )

    assert response["data"]["status"] == "accepted"
    cross_session = dispatch(
        {
            "version": "1.1",
            "method": "task.get",
            "params": {"session_id": "other", "task_id": response["data"]["task_id"]},
        },
        runtime=runtime,
        actions=actions,
        tasks=tasks,
    )
    assert cross_session["error"]["code"] == "SESSION_NOT_FOUND"
    described = dispatch({"version": "1.1", "method": "protocol.describe"})
    assert "task.list" in described["data"]["methods"]


def test_history_pruning_removes_durable_rows(tmp_path: Path):
    store = TaskStore(tmp_path / "tasks.db")
    with sqlite3.connect(store.path) as connection:
        for index in range(3):
            connection.execute(
                """
                INSERT INTO bridge_tasks
                (task_id, session_id, kind, subject_id, status, created_at, updated_at, side_effects_possible)
                VALUES (?, 'session-1', 'tool.execute', ?, 'succeeded', ?, ?, 0)
                """,
                (f"old-{index}", f"action-{index}", str(index), str(index)),
            )
    actions = ActionRuntime(tmp_path)
    tasks = TaskRuntime(actions, lambda _event: None, store, max_history=3)
    prepared = _approved_tool(actions, "session-1")

    tasks.submit_tool("session-1", prepared["action_id"], prepared["approval_id"])

    with sqlite3.connect(store.path) as connection:
        remaining = {row[0] for row in connection.execute("SELECT task_id FROM bridge_tasks")}
    assert "old-0" not in remaining
    assert len(remaining) == 3
