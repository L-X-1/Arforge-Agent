from __future__ import annotations

import threading
import time

from arforge.bridge import dispatch
from arforge.core.hooks import HookContext, HookEvent, get_hook_manager
from arforge.core.interrupt import install_interrupt_hook
from arforge.product.prompt_queue_runtime import PromptQueueRuntime
from arforge.product.session_runtime import SessionRuntime


class InterruptibleAgent:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.continue_to_model = threading.Event()
        self.messages_seen: list[dict] = []

    def should_use_multiagent(self, _user_input: str) -> bool:
        return False

    def chat_stream(self, _user_input: str):
        self.started.set()
        self.continue_to_model.wait(2)
        context = HookContext(
            HookEvent.PRE_LLM_CALL,
            messages=[{"role": "system", "content": "system"}],
        )
        decision = get_hook_manager().fire(context)
        assert decision.action in {"proceed", "modify"}
        self.messages_seen = list(context.messages or [])
        yield {"type": "answer_delta", "data": {"content": "done"}}
        yield {"type": "done", "data": {}}


class NonInterruptibleAgent:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.started = threading.Event()
        self.release = threading.Event()

    def should_use_multiagent(self, _user_input: str) -> bool:
        return False

    def chat_stream(self, user_input: str):
        self.calls.append(user_input)
        if len(self.calls) == 1:
            self.started.set()
            self.release.wait(2)
        yield {"type": "answer_delta", "data": {"content": f"answer:{user_input}"}}
        yield {"type": "done", "data": {}}


def _wait_until(predicate, timeout: float = 3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.005)
    raise AssertionError("condition was not reached")


def test_live_steer_is_injected_only_into_the_target_operation() -> None:
    install_interrupt_hook()
    events: list[dict] = []
    first = InterruptibleAgent()
    second = InterruptibleAgent()
    agents = iter((first, second))
    runtime = SessionRuntime(events.append, agent_factory=lambda: next(agents))
    first_session = runtime.create_session()
    second_session = runtime.create_session()
    first_operation = runtime.start_chat(first_session["session_id"], "first", 10_000)
    second_operation = runtime.start_chat(second_session["session_id"], "second", 10_000)
    runtime.release_operation(first_operation["operation_id"])
    runtime.release_operation(second_operation["operation_id"])
    assert first.started.wait(1)
    assert second.started.wait(1)

    steered = dispatch(
        {
            "version": "1.2",
            "method": "chat.steer",
            "params": {
                "operation_id": first_operation["operation_id"],
                "instruction": "prioritize tests",
            },
        },
        runtime=runtime,
    )
    assert steered["ok"] is True
    first.continue_to_model.set()
    second.continue_to_model.set()
    _wait_until(
        lambda: runtime.get_operation(first_operation["operation_id"])
        if runtime.get_operation(first_operation["operation_id"])["status"]
        == "succeeded"
        else None
    )
    _wait_until(
        lambda: runtime.get_operation(second_operation["operation_id"])
        if runtime.get_operation(second_operation["operation_id"])["status"]
        == "succeeded"
        else None
    )

    assert first.messages_seen[-1] == {
        "role": "user",
        "content": "[Runtime instruction] prioritize tests",
    }
    assert all("prioritize tests" not in str(item) for item in second.messages_seen)
    assert any(event["type"] == "chat.steer.applied" for event in events)
    runtime.shutdown()


def test_unapplied_steer_is_durably_deferred_as_the_next_prompt(tmp_path) -> None:
    events: list[dict] = []
    agent = NonInterruptibleAgent()
    queue = PromptQueueRuntime(tmp_path / "queue.db")
    runtime = SessionRuntime(
        events.append,
        agent_factory=lambda: agent,
        prompt_queue=queue,
    )
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "first", 10_000)
    runtime.release_operation(operation["operation_id"])
    assert agent.started.wait(1)

    runtime.steer_operation(operation["operation_id"], "verify migration first")
    agent.release.set()
    _wait_until(lambda: len(agent.calls) == 2)
    _wait_until(
        lambda: next(
            (
                event
                for event in events
                if event["type"] == "chat.steer.deferred"
            ),
            None,
        )
    )

    assert agent.calls == ["first", "verify migration first"]
    assert queue.list(session["session_id"])["count"] == 0
    runtime.shutdown()

