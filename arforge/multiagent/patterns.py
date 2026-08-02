"""Collaboration patterns — Pipeline, Fanout, Adversarial, Iterative.

Each pattern is a factory function that produces a pre-configured Conversation
with the appropriate Task dependency structure.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from arforge.multiagent.protocol import Conversation, Task

if TYPE_CHECKING:
    pass


def pipeline(roles: list[str], goal: str, role_goals: list[str] | None = None) -> Conversation:
    """Pipeline pattern: A → B → C, each step's output feeds the next.

    Each task depends on the previous one, forming a strict sequential chain.

    Args:
        roles: List of role names in execution order (e.g. ["SearcherAgent", "CoderAgent", "TesterAgent"])
        goal: High-level goal shared by all tasks
        role_goals: Optional per-role goal overrides (same length as roles)

    Returns:
        Conversation with tasks chained by depends_on
    """
    tasks = []
    for i, role in enumerate(roles):
        step_goal = role_goals[i] if role_goals and i < len(role_goals) else goal
        task = Task(
            task_id=f"pipe_{i}",
            role=role,
            goal=step_goal,
            depends_on=[f"pipe_{i - 1}"] if i > 0 else [],
            priority=100 - i,  # Earlier steps have higher priority
        )
        tasks.append(task)

    return Conversation(
        conversation_id=f"pipeline_{uuid.uuid4().hex[:8]}",
        master_goal=goal,
        tasks=tasks,
    )


def fanout(roles: list[str], goal: str, role_goals: list[str] | None = None) -> Conversation:
    """Fanout pattern: multiple agents process the same goal in parallel.

    All tasks are independent (no depends_on), allowing the dispatcher to
    run them concurrently.

    Args:
        roles: List of role names to fan out
        goal: Shared goal
        role_goals: Optional per-role goal overrides

    Returns:
        Conversation with independent parallel tasks
    """
    tasks = []
    for i, role in enumerate(roles):
        step_goal = role_goals[i] if role_goals and i < len(role_goals) else goal
        tasks.append(
            Task(
                task_id=f"fan_{i}",
                role=role,
                goal=step_goal,
                depends_on=[],
                priority=100,
            )
        )

    return Conversation(
        conversation_id=f"fanout_{uuid.uuid4().hex[:8]}",
        master_goal=goal,
        tasks=tasks,
    )


def adversarial(
    coder_role: str = "CoderAgent",
    reviewer_role: str = "ReviewerAgent",
    tester_role: str = "TesterAgent",
    goal: str = "",
) -> Conversation:
    """Adversarial pattern: Coder writes → Reviewer audits → Coder fixes → Tester verifies.

    This is the strongest quality-assurance pattern. The Reviewer acts as an
    adversary to the Coder, and the Tester provides the final gate.

    Args:
        coder_role: Role for implementation (default "CoderAgent")
        reviewer_role: Role for review (default "ReviewerAgent")
        tester_role: Role for testing (default "TesterAgent")
        goal: Task goal

    Returns:
        Conversation with adversarial task chain
    """
    tasks = [
        Task(task_id="adv_code", role=coder_role, goal=f"实现：{goal}", depends_on=[], priority=100),
        Task(task_id="adv_review", role=reviewer_role, goal=f"审查代码实现：{goal}", depends_on=["adv_code"], priority=90),
        Task(task_id="adv_fix", role=coder_role, goal=f"根据审查意见修改代码：{goal}", depends_on=["adv_review"], priority=80),
        Task(task_id="adv_test", role=tester_role, goal=f"测试最终代码：{goal}", depends_on=["adv_fix"], priority=70),
    ]

    return Conversation(
        conversation_id=f"adversarial_{uuid.uuid4().hex[:8]}",
        master_goal=goal,
        tasks=tasks,
    )


def iterative(
    goal: str,
    roles: list[str] | None = None,
    max_iterations: int = 3,
) -> Conversation:
    """Iterative refinement: MasterAgent evaluates and re-dispatches until satisfied.

    Unlike the other patterns, iterative execution is driven by MasterAgent.handle()'s
    evaluation loop — this factory just sets up the initial task set with metadata
    stored in shared_memory so the loop knows when to stop.

    Args:
        goal: Task goal
        roles: Initial role set (defaults to Searcher + Coder + Reviewer)
        max_iterations: Max refinement rounds

    Returns:
        Conversation configured for iterative refinement
    """
    if roles is None:
        roles = ["SearcherAgent", "CoderAgent", "ReviewerAgent"]

    tasks = []
    for i, role in enumerate(roles):
        task = Task(
            task_id=f"iter_{i}",
            role=role,
            goal=f"[迭代初版] {goal}",
            depends_on=[f"iter_{i - 1}"] if i > 0 else [],
            priority=100 - i,
        )
        tasks.append(task)

    return Conversation(
        conversation_id=f"iterative_{uuid.uuid4().hex[:8]}",
        master_goal=goal,
        tasks=tasks,
        shared_memory={
            "pattern": "iterative",
            "max_iterations": max_iterations,
            "current_iteration": 0,
        },
    )
