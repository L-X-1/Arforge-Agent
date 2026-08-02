from __future__ import annotations

import time

import pytest

from arforge.product.session_runtime import SessionRuntime, SessionRuntimeError
from arforge.reasoning.effort import (
    adjust_step_budget,
    multiagent_iteration_budget,
    normalize_reasoning_effort,
)
from arforge.reasoning.prompts import select_reasoning_by_effort


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("low", "low"),
        ("medium", "medium"),
        ("high", "high"),
        ("ultra", "ultra"),
        ("quick", "low"),
        ("normal", "medium"),
        ("deep", "high"),
    ],
)
def test_reasoning_effort_normalizes_to_four_public_tiers(value, expected):
    assert normalize_reasoning_effort(value, strict=True) == expected


def test_all_four_depths_have_distinct_prompts_and_ordered_budgets():
    tiers = ("low", "medium", "high", "ultra")
    prompts = [select_reasoning_by_effort(tier) for tier in tiers]
    step_budgets = [adjust_step_budget(20, tier) for tier in tiers]
    orchestration_budgets = [multiagent_iteration_budget(tier) for tier in tiers]

    assert len(set(prompts)) == 4
    assert step_budgets == sorted(step_budgets)
    assert len(set(step_budgets)) == 4
    assert orchestration_budgets == [2, 3, 4, 5]
    assert "multi-pass" in prompts[-1]


class _SingleRouteAgent:
    def __init__(self):
        self.reasoning_effort = "medium"

    def should_use_multiagent(self, _user_input):
        return False

    def chat_stream(self, _user_input, reasoning_effort=None):
        assert reasoning_effort in {None, "high"}
        yield {"type": "reasoning_started", "data": {}}
        yield {"type": "reasoning_completed", "data": {"reasoning": {}}}
        yield {"type": "answer_delta", "data": {"content": "done"}}
        yield {"type": "done", "data": {"answer": "done"}}


def test_bridge_normalizes_legacy_alias_and_emits_canonical_depth():
    events: list[dict] = []
    runtime = SessionRuntime(events.append, agent_factory=_SingleRouteAgent)
    session = runtime.create_session()
    operation = runtime.start_chat(
        session["session_id"],
        "explain this",
        10_000,
        reasoning_effort="deep",
    )
    runtime.release_operation(operation["operation_id"])

    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if runtime.get_operation(operation["operation_id"])["status"] == "succeeded":
            break
        time.sleep(0.005)
    else:
        raise AssertionError("chat operation did not finish")

    started = next(event for event in events if event["type"] == "operation.started")
    assert started["data"]["reasoning_effort"] == "high"


def test_bridge_rejects_unknown_depth():
    runtime = SessionRuntime(lambda _event: None, agent_factory=_SingleRouteAgent)
    session = runtime.create_session()
    with pytest.raises(SessionRuntimeError, match="low, medium, high, or ultra"):
        runtime.start_chat(
            session["session_id"],
            "hello",
            10_000,
            reasoning_effort="maximum",
        )
