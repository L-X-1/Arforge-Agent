from __future__ import annotations

import threading
import time

from arforge.cli_live import CliLiveSession
from arforge.product.prompt_queue_runtime import PromptQueueRuntime
from arforge.product.session_runtime import SessionRuntime


class BlockingAgent:
    def __init__(self):
        self.conversation_history: list[dict] = []
        self.release_first = threading.Event()
        self.started: list[str] = []

    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, value: str, **_kwargs):
        self.started.append(value)
        yield {"type": "reasoning_started", "data": {}}
        if value == "first":
            self.release_first.wait(2)
        answer = f"answer:{value}"
        yield {"type": "reasoning_completed", "data": {"reasoning": {}}}
        yield {"type": "answer_delta", "data": {"content": answer}}
        self.conversation_history.extend([
            {"role": "user", "content": value},
            {"role": "assistant", "content": answer},
        ])
        yield {
            "type": "done",
            "data": {
                "answer": answer,
                "reasoning": {},
                "tool_events": [],
                "artifacts": [],
            },
        }


def _live(tmp_path, agent):
    queue = PromptQueueRuntime(tmp_path / "queue.db")

    def factory(emit):
        return SessionRuntime(
            emit,
            agent_factory=lambda: agent,
            prompt_queue=queue,
        )

    return CliLiveSession(
        agent,
        {
            "effort": "medium",
            "permission_mode": "autoApprove",
            "input_mode": "agent",
        },
        lang="en",
        runtime_factory=factory,
    )


def test_live_cli_queues_input_while_streaming_and_runs_fifo(tmp_path):
    agent = BlockingAgent()
    live = _live(tmp_path, agent)
    try:
        first = live.submit("first")
        deadline = time.monotonic() + 2
        while not live.active and time.monotonic() < deadline:
            time.sleep(0.01)
        second = live.submit("second")

        assert first["kind"] == "started"
        assert second["kind"] == "queued"
        assert live.runtime.list_queued_chats(live.session_id)["count"] == 1

        agent.release_first.set()
        deadline = time.monotonic() + 3
        while agent.started != ["first", "second"] and time.monotonic() < deadline:
            time.sleep(0.01)
        while live.active and time.monotonic() < deadline:
            time.sleep(0.01)

        assert agent.started == ["first", "second"]
        assert live.runtime.list_queued_chats(live.session_id)["count"] == 0
    finally:
        agent.release_first.set()
        live.shutdown()


def test_live_cli_accepts_steering_for_the_active_operation(tmp_path):
    agent = BlockingAgent()
    live = _live(tmp_path, agent)
    try:
        live.submit("first")
        deadline = time.monotonic() + 2
        while not live.active and time.monotonic() < deadline:
            time.sleep(0.01)

        result = live.submit("/steer prioritize the failing test")

        assert result["kind"] == "steer"
        assert result["accepted"] is True
        assert result["pending"] == 1
    finally:
        agent.release_first.set()
        live.shutdown()


def test_live_cli_confirmation_is_answered_through_the_input_loop(tmp_path):
    agent = BlockingAgent()
    live = _live(tmp_path, agent)
    answer = {}

    def request():
        answer["approved"] = live._request_confirmation("medium", "run tests")

    thread = threading.Thread(target=request)
    thread.start()
    deadline = time.monotonic() + 2
    while not live.accepts_control_input("yes") and time.monotonic() < deadline:
        time.sleep(0.01)
    result = live.submit("yes")
    thread.join(2)

    try:
        assert result == {"kind": "confirmation", "approved": True}
        assert answer == {"approved": True}
    finally:
        live.shutdown()
