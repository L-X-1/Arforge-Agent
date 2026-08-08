from __future__ import annotations

from pathlib import Path

from arforge.product.direct_dispatch import PROTOCOL, dispatch
from arforge.product.goal_runtime import GoalRuntime, GoalRuntimeError


def test_goal_queue_advances_only_after_terminal_completion(tmp_path: Path) -> None:
    runtime = GoalRuntime(tmp_path / "goals.db")
    first = runtime.create("session-1", "Finish the migration")
    second = runtime.create("session-1", "Verify the migration")

    assert first["status"] == "active"
    assert second["status"] == "queued"

    runtime.bind_operation("session-1", first["goal_id"], "operation-1")
    runtime.observe_event(
        {"type": "operation.completed", "operation_id": "operation-1", "data": {}}
    )

    page = runtime.list("session-1")
    assert page["active"]["goal_id"] == second["goal_id"]
    assert page["active"]["status"] == "active"
    assert next(
        item for item in page["history"] if item["goal_id"] == first["goal_id"]
    )["status"] == "completed"


def test_pausing_running_goal_survives_cancel_event(tmp_path: Path) -> None:
    runtime = GoalRuntime(tmp_path / "goals.db")
    goal = runtime.create("session-1", "Long validation")
    runtime.bind_operation("session-1", goal["goal_id"], "operation-1")

    paused = runtime.pause("session-1", goal["goal_id"])
    runtime.observe_event(
        {"type": "operation.cancelled", "operation_id": "operation-1", "data": {}}
    )

    assert paused["status"] == "paused"
    assert runtime.get("session-1", goal["goal_id"])["status"] == "paused"
    assert runtime.resume("session-1", goal["goal_id"])["status"] == "active"


def test_restart_marks_orphaned_running_goal_blocked(tmp_path: Path) -> None:
    path = tmp_path / "goals.db"
    runtime = GoalRuntime(path)
    goal = runtime.create("session-1", "Recover after restart")
    runtime.bind_operation("session-1", goal["goal_id"], "operation-1")

    reopened = GoalRuntime(path)
    restored = reopened.get("session-1", goal["goal_id"])

    assert restored["status"] == "blocked"
    assert "interrupted" in restored["last_error"]


def test_reorder_requires_exact_queued_set(tmp_path: Path) -> None:
    runtime = GoalRuntime(tmp_path / "goals.db")
    runtime.create("session-1", "Active")
    second = runtime.create("session-1", "Second")
    third = runtime.create("session-1", "Third")

    reordered = runtime.reorder(
        "session-1",
        [third["goal_id"], second["goal_id"]],
    )
    assert [item["goal_id"] for item in reordered["queued"]] == [
        third["goal_id"],
        second["goal_id"],
    ]

    try:
        runtime.reorder("session-1", [second["goal_id"]])
    except GoalRuntimeError as exc:
        assert exc.code == "INVALID_PARAMS"
    else:
        raise AssertionError("partial queue reorder must fail")


class _RuntimeStub:
    def __init__(self) -> None:
        self.cancelled: list[str] = []

    def get_session(self, session_id: str):
        if session_id != "session-1":
            raise AssertionError("unexpected session")
        return {"session_id": session_id}

    def start_chat(
        self,
        session_id: str,
        objective: str,
        timeout_ms: int,
        *,
        reasoning_effort: str,
        permission_mode: str | None,
        context: dict,
    ):
        assert objective == "Run all checks"
        assert context["goal"] is True
        return {
            "operation_id": "operation-1",
            "session_id": session_id,
            "status": "accepted",
        }

    def get_operation(self, operation_id: str):
        return {"operation_id": operation_id, "status": "accepted"}

    def cancel_chat(self, operation_id: str):
        self.cancelled.append(operation_id)
        return {"operation_id": operation_id, "status": "cancellation_requested"}


def _request(method: str, params: dict) -> dict:
    return {
        "protocol": PROTOCOL,
        "version": "1.2",
        "id": 1,
        "method": method,
        "params": params,
    }


def test_bridge_goal_run_preserves_goal_mode_context(tmp_path: Path) -> None:
    goals = GoalRuntime(tmp_path / "goals.db")
    runtime = _RuntimeStub()
    created = goals.create("session-1", "Run all checks")

    response = dispatch(
        _request(
            "goal.run",
            {"session_id": "session-1", "goal_id": created["goal_id"]},
        ),
        runtime=runtime,  # type: ignore[arg-type]
        goals=goals,
    )

    assert response["ok"] is True
    assert response["data"]["goal"]["status"] == "running"
    assert response["data"]["operation"]["operation_id"] == "operation-1"

    paused = dispatch(
        _request(
            "goal.pause",
            {"session_id": "session-1", "goal_id": created["goal_id"]},
        ),
        runtime=runtime,  # type: ignore[arg-type]
        goals=goals,
    )
    assert paused["ok"] is True
    assert paused["data"]["status"] == "paused"
    assert runtime.cancelled == ["operation-1"]
