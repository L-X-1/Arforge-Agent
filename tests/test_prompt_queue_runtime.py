from __future__ import annotations

import threading
import time
from pathlib import Path

from arforge.product.direct_dispatch import dispatch
from arforge.product.prompt_queue_runtime import PromptQueueRuntime
from arforge.product.session_runtime import SessionRuntime


class QueueAgent:
    def __init__(self):
        self.calls = 0
        self.first_started = threading.Event()
        self.release_first = threading.Event()

    def should_use_multiagent(self, _user_input: str) -> bool:
        return False

    def chat_stream(self, user_input: str):
        self.calls += 1
        if self.calls == 1:
            self.first_started.set()
            self.release_first.wait(2)
        yield {"type": "answer_delta", "data": {"content": f"answer:{user_input}"}}
        yield {"type": "done", "data": {}}


def _wait_until(predicate, timeout: float = 3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.01)
    raise AssertionError("condition was not reached")


def test_busy_session_runs_durable_queue_in_fifo_order(tmp_path: Path) -> None:
    events: list[dict] = []
    agent = QueueAgent()
    queue = PromptQueueRuntime(tmp_path / "queue.db")
    runtime = SessionRuntime(
        events.append,
        agent_factory=lambda: agent,
        prompt_queue=queue,
    )
    session = runtime.create_session()
    first = runtime.start_chat(session["session_id"], "first", 10_000)
    runtime.release_operation(first["operation_id"])
    assert agent.first_started.wait(1)

    queued = runtime.enqueue_chat(
        session["session_id"],
        "second",
        10_000,
        reasoning_effort="high",
        permission_mode="autoApprove",
        context={},
    )
    assert queued["position"] == 1
    assert runtime.list_queued_chats(session["session_id"])["count"] == 1

    agent.release_first.set()
    started = _wait_until(
        lambda: next(
            (
                event
                for event in events
                if event["type"] == "chat.queued.started"
            ),
            None,
        )
    )
    second_operation = started["data"]["operation"]
    final = _wait_until(
        lambda: runtime.get_operation(second_operation["operation_id"])
        if runtime.get_operation(second_operation["operation_id"])["status"]
        in {"succeeded", "failed"}
        else None
    )

    assert final["status"] == "succeeded"
    assert agent.calls == 2
    assert queue.list(session["session_id"])["count"] == 0
    assert started["data"]["input"] == "second"
    runtime.shutdown()


def test_cancelled_turn_preserves_queued_follow_up(tmp_path: Path) -> None:
    agent = QueueAgent()
    queue = PromptQueueRuntime(tmp_path / "queue.db")
    runtime = SessionRuntime(
        lambda _event: None,
        agent_factory=lambda: agent,
        prompt_queue=queue,
    )
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "first", 10_000)
    runtime.release_operation(operation["operation_id"])
    assert agent.first_started.wait(1)
    queued = runtime.enqueue_chat(session["session_id"], "keep me", 10_000)

    runtime.cancel_operation(operation["operation_id"])
    agent.release_first.set()
    _wait_until(
        lambda: runtime.get_operation(operation["operation_id"])
        if runtime.get_operation(operation["operation_id"])["status"] == "cancelled"
        else None
    )

    assert queue.list(session["session_id"])["items"][0]["queue_id"] == queued["queue_id"]
    runtime.shutdown()


def test_bridge_exposes_queue_list_and_delete(tmp_path: Path) -> None:
    agent = QueueAgent()
    runtime = SessionRuntime(
        lambda _event: None,
        agent_factory=lambda: agent,
        prompt_queue=PromptQueueRuntime(tmp_path / "queue.db"),
    )
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "first", 10_000)
    runtime.release_operation(operation["operation_id"])
    assert agent.first_started.wait(1)

    enqueued = dispatch(
        {
            "version": "1.2",
            "method": "chat.enqueue",
            "params": {
                "session_id": session["session_id"],
                "input": "queued",
                "timeout_ms": 10_000,
            },
        },
        runtime=runtime,
    )
    listed = dispatch(
        {
            "version": "1.2",
            "method": "chat.queue.list",
            "params": {"session_id": session["session_id"]},
        },
        runtime=runtime,
    )
    deleted = dispatch(
        {
            "version": "1.2",
            "method": "chat.queue.delete",
            "params": {
                "session_id": session["session_id"],
                "queue_id": enqueued["data"]["queue_id"],
            },
        },
        runtime=runtime,
    )

    assert enqueued["ok"] is True
    assert listed["data"]["count"] == 1
    assert deleted["data"]["deleted"] is True
    runtime.cancel_operation(operation["operation_id"])
    agent.release_first.set()
    runtime.shutdown()
