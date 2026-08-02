"""Planning orchestrator."""

from __future__ import annotations

from dataclasses import dataclass, field

from arforge.planning.planner import ExecutionPlan, quick_plan
from arforge.planning.reasoning import reason_about_task


@dataclass
class OrchestrationResult:
    goal: str
    plan: ExecutionPlan
    reasoning: dict
    messages: list[str] = field(default_factory=list)


def orchestrate_task(goal: str) -> OrchestrationResult:
    reasoning = reason_about_task(goal)
    plan = quick_plan(goal)
    messages = [f"category={reasoning['category']}", f"steps={len(plan.steps)}"]
    return OrchestrationResult(goal, plan, reasoning, messages)
