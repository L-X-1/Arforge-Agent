"""Interruptible cooperative wait and Bridge wake tests."""

from __future__ import annotations

import json
import threading
import time

import pytest

import arforge.tools.basic_tools  # noqa: F401 - register calculate probe
import arforge.tools.wait_tools  # noqa: F401 - register cooperative_wait
from arforge.product.direct_dispatch import dispatch
from arforge.core.agent_loop_v2 import AgentLoopV2
from arforge.product.session_runtime import SessionRuntime
from arforge.tool_registry import REGISTRY
from arforge.wait_runtime import (
    WaitManager,
    WaitRuntimeError,
    cooperative_wait,
    wait_scope,
)
from arforge.workspace_context import current_session_id, execution_scope


def test_wait_completes_with_periodic_check_ins():
    manager = WaitManager()
    events = []
    result = manager.wait(
        "session-1",
        0.16,
        check_in_interval=0.05,
        reason="waiting for build",
        on_event=lambda event_type, data: events.append((event_type, data)),
    )

    assert result["status"] == "completed"
    assert result["check_in_count"] >= 2
    assert events[0][0] == "wait.started"
    assert any(event_type == "wait.check_in" for event_type, _data in events)
    assert events[-1][0] == "wait.completed"
    assert manager.active("session-1") is None


def test_wait_can_be_woken_from_another_thread():
    manager = WaitManager()
    result = {}

    thread = threading.Thread(
        target=lambda: result.update(
            manager.wait(
                "session-1",
                2,
                check_in_interval=0.5,
                reason="waiting for approval",
            )
        )
    )
    thread.start()
    deadline = time.monotonic() + 1
    active = None
    while time.monotonic() < deadline:
        active = manager.active("session-1")
        if active is not None:
            break
        time.sleep(0.01)
    assert active is not None
    wake = manager.wake("session-1", active["wait_id"])
    assert wake["wake_requested"] is True
    thread.join(1)
    assert thread.is_alive() is False
    assert result["status"] == "woken"


def test_wait_honors_cancellation_and_deadline():
    manager = WaitManager()
    cancelled = threading.Event()
    cancelled.set()
    result = manager.wait(
        "cancelled",
        1,
        check_in_interval=0.5,
        cancel_event=cancelled,
    )
    assert result["status"] == "cancelled"

    timed_out = manager.wait(
        "timed-out",
        1,
        check_in_interval=0.5,
        deadline_monotonic=time.monotonic() + 0.06,
    )
    assert timed_out["status"] == "timed_out"
    assert timed_out["elapsed_seconds"] < 0.3


def test_wait_rejects_unbounded_check_in_volume_and_wrong_wake():
    manager = WaitManager()
    with pytest.raises(WaitRuntimeError, match="maximum"):
        manager.wait("session-1", 300, check_in_interval=0.05)
    with pytest.raises(WaitRuntimeError, match="no active wait"):
        manager.wake("session-1")


def test_parallel_tool_execution_inherits_wait_and_session_context():
    cancel = threading.Event()
    cancel.set()
    events = []
    with execution_scope("session-parallel"), wait_scope(
        manager=WaitManager(),
        cancel_event=cancel,
        on_event=lambda event_type, data: events.append((event_type, data)),
    ):
        results = REGISTRY.execute_calls(
            [
                (
                    "cooperative_wait",
                    {
                        "duration_seconds": 1,
                        "check_in_interval": 0.5,
                        "reason": "parallel context probe",
                    },
                ),
                ("calculate", {"expression": "2+2"}),
            ],
            parallel=True,
        )
    payload = json.loads(results[0].output)
    assert payload["session_id"] == "session-parallel"
    assert payload["status"] == "cancelled"
    assert results[1].success is True
    assert [event_type for event_type, _data in events] == [
        "wait.started",
        "wait.cancelled",
    ]


class AgenticFakeAgent:
    def __init__(self):
        self.reasoning_effort = "normal"
        self.conversation_history = []

    def should_use_multiagent(self, _value):
        return False


class LoopResult:
    answer = "wait finished"
    tool_calls = []
    trace = []
    deliveries = []


def _wait_for_status(runtime: SessionRuntime, operation_id: str, statuses: set[str]):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        operation = runtime.get_operation(operation_id)
        if operation["status"] in statuses:
            return operation
        time.sleep(0.01)
    raise AssertionError("operation did not reach terminal status")


def test_bridge_can_observe_and_wake_agent_wait(monkeypatch):
    def fake_run_agentic(
        self,
        user_input,
        max_steps=10,
        on_token=None,
        on_delivery=None,
        extra_system="",
        resume_messages=None,
    ):
        del self, user_input, max_steps, on_delivery, extra_system, resume_messages
        result = cooperative_wait(
            current_session_id(),
            2,
            check_in_interval=0.1,
            reason="external service",
        )
        if on_token:
            on_token(f"wait {result['status']}")
        return LoopResult()

    monkeypatch.setattr(AgentLoopV2, "run_agentic", fake_run_agentic)
    manager = WaitManager()
    events = []
    runtime = SessionRuntime(
        events.append,
        agent_factory=AgenticFakeAgent,
        wait_manager=manager,
    )
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "等待外部服务", 5_000)
    runtime.release_operation(operation["operation_id"])

    deadline = time.monotonic() + 1
    active = None
    while time.monotonic() < deadline:
        response = dispatch(
            {
                "version": "1.2",
                "method": "wait.active",
                "params": {"session_id": session["session_id"]},
            },
            runtime=runtime,
        )
        active = response["data"]["wait"]
        if active is not None:
            break
        time.sleep(0.01)
    assert active is not None

    woken = dispatch(
        {
            "version": "1.2",
            "method": "wait.wake",
            "params": {
                "session_id": session["session_id"],
                "wait_id": active["wait_id"],
            },
        },
        runtime=runtime,
    )
    assert woken["ok"] is True
    assert _wait_for_status(runtime, operation["operation_id"], {"succeeded"})["status"] == "succeeded"
    event_types = [item["type"] for item in events]
    assert "wait.started" in event_types
    assert "wait.woken" in event_types
    described = dispatch({"version": "1.2", "method": "protocol.describe"})
    assert "wait.wake" in described["data"]["mutating_methods"]


def test_chat_cancel_interrupts_agent_wait(monkeypatch):
    def fake_run_agentic(self, user_input, **kwargs):
        del self, user_input, kwargs
        cooperative_wait(
            current_session_id(),
            2,
            check_in_interval=0.1,
            reason="cancel probe",
        )
        return LoopResult()

    monkeypatch.setattr(AgentLoopV2, "run_agentic", fake_run_agentic)
    manager = WaitManager()
    runtime = SessionRuntime(
        lambda _event: None,
        agent_factory=AgenticFakeAgent,
        wait_manager=manager,
    )
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "等待并允许取消", 5_000)
    runtime.release_operation(operation["operation_id"])
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline and manager.active(session["session_id"]) is None:
        time.sleep(0.01)
    runtime.cancel_operation(operation["operation_id"])
    terminal = _wait_for_status(runtime, operation["operation_id"], {"cancelled"})
    assert terminal["status"] == "cancelled"
    assert manager.active(session["session_id"]) is None
