"""DynamicTaskRouter — escalate failed tasks to specialized recovery agents.

When a SubAgent fails after exhausting retries, the router can:
  - Escalate to DebuggerAgent with full context (error + task goal + tool calls)
  - Route to a different agent type based on error classification
  - Track escalation chains to prevent infinite loops

This implements dynamic subagent delegation with role-based routing
when one agent can't complete a task.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from arforge.multiagent.protocol import Task, TaskResult

logger = logging.getLogger(__name__)

# Maximum escalation depth to prevent infinite loops
_MAX_ESCALATION_DEPTH = 2


@dataclass
class EscalationRecord:
    """Tracks a single escalation in the chain."""
    original_task_id: str
    original_role: str
    escalated_role: str
    error_summary: str
    timestamp: float = 0.0

    def to_dict(self) -> dict:
        return {
            "original_task_id": self.original_task_id,
            "original_role": self.original_role,
            "escalated_role": self.escalated_role,
            "error_summary": self.error_summary,
            "timestamp": self.timestamp,
        }


@dataclass
class RouterConfig:
    """Configuration for dynamic task routing."""
    max_escalation_depth: int = _MAX_ESCALATION_DEPTH
    enable_debugger_escalation: bool = True
    enable_role_swap: bool = True
    # Maps error keywords to alternative roles
    error_role_map: dict[str, str] = field(default_factory=lambda: {
        "syntax": "DebuggerAgent",
        "import": "DebuggerAgent",
        "timeout": "CoderAgent",      # timeout → try simpler approach
        "timed out": "CoderAgent",   # timed out → try simpler approach
        "permission": "ReviewerAgent", # permission issues → review approach
        "not found": "SearcherAgent",  # not found → search more
        "token": "CoderAgent",         # token exceeded → try with less context
    })


class DynamicTaskRouter:
    """Routes failed tasks to recovery agents based on error analysis.

    Usage (inside TaskDispatcher._execute_one after retry exhaustion):
        router = DynamicTaskRouter()
        recovery_task = router.escalate(failed_result, original_task, conversation)
        if recovery_task:
            recovery_result = dispatcher._execute_one(recovery_task, conversation)
    """

    def __init__(self, config: RouterConfig | None = None):
        self.config = config or RouterConfig()
        self._escalation_count: dict[str, int] = {}  # task_id → depth

    def should_escalate(self, task: Task, conversation) -> bool:
        """Check if escalation is appropriate for this task."""
        depth = self._escalation_count.get(task.task_id, 0)
        if depth >= self.config.max_escalation_depth:
            logger.debug(
                "Task %s hit max escalation depth (%d), not escalating",
                task.task_id, depth,
            )
            return False
        return True

    def mark_escalated(self, task_id: str, depth: int | None = None) -> None:
        """Mark a task as escalated at a given depth (prevents further escalation)."""
        if depth is not None:
            self._escalation_count[task_id] = depth
        else:
            self._escalation_count[task_id] = self._escalation_count.get(task_id, 0) + 1

    def classify_error(self, error_text: str) -> str:
        """Classify an error string into a category for role selection."""
        error_lower = error_text.lower()
        for keyword, role in self.config.error_role_map.items():
            if keyword in error_lower:
                return role
        return "DebuggerAgent"  # default escalation target

    def escalate(
        self,
        failed_result: TaskResult,
        original_task: Task,
        conversation,
    ) -> Task | None:
        """Create a recovery Task for the failed task.

        Returns a new Task to be dispatched to a recovery agent,
        or None if escalation is not appropriate.
        """
        if not self.should_escalate(original_task, conversation):
            return None

        error_text = failed_result.error or failed_result.output or ""
        recovery_role = self.classify_error(error_text)

        # Don't escalate to the same role that just failed
        if recovery_role == original_task.role:
            recovery_role = "DebuggerAgent"

        depth = self._escalation_count.get(original_task.task_id, 0) + 1
        self._escalation_count[original_task.task_id] = depth

        # Build the recovery task with full context
        import uuid
        from arforge.multiagent.protocol import Task

        recovery_goal = (
            f"[Escalation L{depth}] Original task failed: {original_task.goal}\n"
            f"Error from {original_task.role}: {error_text[:500]}\n"
            f"Tool calls made: {len(failed_result.tool_calls)}\n"
            f"Please analyze the failure, identify the root cause, and fix it."
        )

        recovery_task = Task(
            task_id=f"escalate_{original_task.task_id}_{uuid.uuid4().hex[:6]}",
            parent_task_id=original_task.task_id,
            role=recovery_role,
            goal=recovery_goal,
            depends_on=[],  # no dependency — run immediately
            priority=original_task.priority + 10,  # slightly lower priority
            inputs={
                "original_task": original_task.to_dict(),
                "error": error_text[:1000],
                "tool_calls": failed_result.tool_calls,
                "escalation_depth": depth,
            },
        )

        # Record escalation in conversation shared memory
        import time as _time
        record = EscalationRecord(
            original_task_id=original_task.task_id,
            original_role=original_task.role,
            escalated_role=recovery_role,
            error_summary=error_text[:200],
            timestamp=_time.time(),
        )
        key = f"_escalation_{original_task.task_id}"
        existing = conversation.get_shared(key, [])
        existing.append(record.to_dict())
        conversation.set_shared(key, existing)

        logger.info(
            "Escalating task %s (%s) → %s (depth %d): %s",
            original_task.task_id, original_task.role,
            recovery_role, depth, error_text[:80],
        )

        return recovery_task


# Module-level convenience
_default_router: DynamicTaskRouter | None = None


def get_router() -> DynamicTaskRouter:
    """Return the default DynamicTaskRouter singleton."""
    global _default_router
    if _default_router is None:
        _default_router = DynamicTaskRouter()
    return _default_router
