"""Simple workflow execution model."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class WorkflowStep:
    name: str
    action: Callable[[], object]
    status: str = "pending"
    result: object = None


@dataclass
class WorkflowResult:
    success: bool
    steps: list[WorkflowStep] = field(default_factory=list)


def run_workflow(steps: list[WorkflowStep]) -> WorkflowResult:
    success = True
    for step in steps:
        try:
            step.result = step.action()
            step.status = "done"
        except Exception as exc:
            step.result = exc
            step.status = "failed"
            success = False
            break
    return WorkflowResult(success, steps)
