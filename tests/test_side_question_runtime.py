from __future__ import annotations

import threading
import time

from arforge.product.direct_dispatch import dispatch
from arforge.product.session_runtime import SessionRuntime


class MainAgent:
    def __init__(self) -> None:
        self.conversation_history = [
            {"role": "user", "content": "previous question"},
            {"role": "assistant", "content": "previous answer"},
        ]
        self.started = threading.Event()
        self.release = threading.Event()

    def should_use_multiagent(self, _user_input: str) -> bool:
        return False

    def chat_stream(self, _user_input: str):
        self.started.set()
        self.release.wait(2)
        yield {"type": "answer_delta", "data": {"content": "main answer"}}
        yield {"type": "done", "data": {}}


class SideAgent:
    def __init__(self) -> None:
        self.conversation_history: list[dict] = []
        self.history_seen: list[dict] = []

    def chat_stream(self, question: str):
        self.history_seen = [dict(item) for item in self.conversation_history]
        yield {"type": "reasoning_delta", "data": {"content": "private"}}
        yield {
            "type": "answer_delta",
            "data": {"content": f"side answer: {question}"},
        }
        yield {"type": "done", "data": {}}
        self.conversation_history.extend(
            [
                {"role": "user", "content": question},
                {"role": "assistant", "content": f"side answer: {question}"},
            ]
        )


def _wait_side(
    runtime: SessionRuntime,
    session_id: str,
    side_question_id: str,
    statuses: set[str],
    timeout: float = 2.0,
) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        record = runtime.get_side_question(session_id, side_question_id)
        if record["status"] in statuses:
            return record
        time.sleep(0.005)
    raise AssertionError(f"side question did not reach {statuses}")


def test_side_question_runs_while_main_turn_is_busy_without_mutating_history() -> None:
    events: list[dict] = []
    main = MainAgent()
    side = SideAgent()
    agents = iter((main, side))
    runtime = SessionRuntime(events.append, agent_factory=lambda: next(agents))
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "long task", 10_000)
    runtime.release_operation(operation["operation_id"])
    assert main.started.wait(1)

    accepted = runtime.start_side_question(
        session["session_id"],
        "what is happening?",
        10_000,
    )
    completed = _wait_side(
        runtime,
        session["session_id"],
        accepted["side_question_id"],
        {"succeeded"},
    )

    assert completed["answer"] == "side answer: what is happening?"
    assert side.history_seen == [
        {"role": "user", "content": "previous question"},
        {"role": "assistant", "content": "previous answer"},
    ]
    assert main.conversation_history == [
        {"role": "user", "content": "previous question"},
        {"role": "assistant", "content": "previous answer"},
    ]
    side_events = [
        event for event in events if event.get("event_id") == accepted["side_question_id"]
    ]
    assert [event["type"] for event in side_events] == [
        "side_question.started",
        "side_question.answer.delta",
        "side_question.completed",
    ]
    assert all("operation_id" not in event for event in side_events)
    assert all("private" not in str(event) for event in side_events)

    runtime.cancel_operation(operation["operation_id"])
    main.release.set()
    runtime.shutdown()


def test_bridge_exposes_side_question_get_list_and_cancel() -> None:
    main = MainAgent()
    side = SideAgent()
    agents = iter((main, side))
    runtime = SessionRuntime(lambda _event: None, agent_factory=lambda: next(agents))
    session = runtime.create_session()

    asked = dispatch(
        {
            "version": "1.2",
            "method": "chat.side.ask",
            "params": {
                "session_id": session["session_id"],
                "question": "status?",
                "timeout_ms": 10_000,
            },
        },
        runtime=runtime,
    )
    assert asked["ok"] is True
    side_question_id = asked["data"]["side_question_id"]
    _wait_side(runtime, session["session_id"], side_question_id, {"succeeded"})

    fetched = dispatch(
        {
            "version": "1.2",
            "method": "chat.side.get",
            "params": {
                "session_id": session["session_id"],
                "side_question_id": side_question_id,
            },
        },
        runtime=runtime,
    )
    listed = dispatch(
        {
            "version": "1.2",
            "method": "chat.side.list",
            "params": {"session_id": session["session_id"]},
        },
        runtime=runtime,
    )
    cancelled = dispatch(
        {
            "version": "1.2",
            "method": "chat.side.cancel",
            "params": {
                "session_id": session["session_id"],
                "side_question_id": side_question_id,
            },
        },
        runtime=runtime,
    )

    assert fetched["data"]["answer"] == "side answer: status?"
    assert listed["data"]["count"] == 1
    assert cancelled["data"]["status"] == "succeeded"
    runtime.shutdown()

