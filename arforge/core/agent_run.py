"""AgentRun — enterprise-grade state machine for agentic task execution.

WP-03: Transforms the raw tool loop into a recoverable, observable run with:
- Formal states: created -> planning -> executing -> verifying -> compacting -> completed
- State transition events with hooks
- Multi-dimensional work budget enforcement
- Automatic compaction integration
- Structured run report generation
- Resume/replay support

Architecture decision: This wraps (does not replace) the existing run_tool_loop in
agentic.py. It adds governance layers — budget, compaction, file tracking, reporting
— as pre/post hooks around the core loop.
"""

from __future__ import annotations

import enum
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from arforge.core.budget import (
    WorkBudget,
    WorkBudgetTracker,
    install_budget_hooks,
)
from arforge.core.change_tracker import install_change_tracker_hook, reset_change_tracker
from arforge.core.compaction import install_compaction_hook
from arforge.core.run_report import (
    get_run_report,
    install_run_report_hook,
    reset_run_report,
)
from arforge.core.run_transaction import (
    RunTransaction,
    get_run_transaction,
    install_run_transaction_hook,
    persist_run_transaction,
    reset_run_transaction,
    revert_run,
    save_run_messages,
)


# ---------------------------------------------------------------------------
# State machine
# ---------------------------------------------------------------------------

class RunState(enum.Enum):
    """AgentRun lifecycle states."""
    CREATED = "created"
    PLANNING = "planning"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    COMPACTING = "compacting"
    WAITING_APPROVAL = "waiting_approval"
    COMPLETED = "completed"
    INCOMPLETE = "incomplete"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    ROLLING_BACK = "rolling_back"


# Terminal states
_TERMINAL_STATES = {
    RunState.COMPLETED,
    RunState.INCOMPLETE,
    RunState.FAILED,
    RunState.INTERRUPTED,
}

# Valid transitions
_TRANSITIONS: dict[RunState, set[RunState]] = {
    RunState.CREATED: {RunState.PLANNING, RunState.FAILED},
    RunState.PLANNING: {RunState.EXECUTING, RunState.FAILED, RunState.INTERRUPTED},
    RunState.EXECUTING: {
        RunState.VERIFYING,
        RunState.COMPACTING,
        RunState.WAITING_APPROVAL,
        RunState.COMPLETED,
        RunState.INCOMPLETE,
        RunState.FAILED,
        RunState.INTERRUPTED,
    },
    RunState.VERIFYING: {
        RunState.EXECUTING,
        RunState.COMPLETED,
        RunState.INCOMPLETE,
        RunState.FAILED,
    },
    RunState.COMPACTING: {RunState.EXECUTING, RunState.FAILED},
    RunState.WAITING_APPROVAL: {RunState.EXECUTING, RunState.FAILED, RunState.INTERRUPTED},
    RunState.COMPLETED: set(),
    RunState.FAILED: {RunState.ROLLING_BACK},
    RunState.INTERRUPTED: {RunState.ROLLING_BACK},
    RunState.ROLLING_BACK: {RunState.FAILED},
}


# ---------------------------------------------------------------------------
# Run result
# ---------------------------------------------------------------------------

@dataclass
class RunResult:
    """Structured result from an AgentRun execution."""
    run_id: str
    state: RunState
    answer: str = ""
    intent: str = "general"
    tool_calls: list[dict] = field(default_factory=list)
    trace: list[dict] = field(default_factory=list)
    steps: int = 0
    elapsed_seconds: float = 0.0
    budget_used: dict[str, int] = field(default_factory=dict)
    budget_limit: dict[str, int] = field(default_factory=dict)
    report: dict | None = None
    error: str | None = None
    messages: list = field(default_factory=list)
    verifications: list[dict] = field(default_factory=list)
    incomplete_report: dict | None = None
    rollback_events: list[dict] = field(default_factory=list)
    observability: dict | None = None


# ---------------------------------------------------------------------------
# AgentRun
# ---------------------------------------------------------------------------

@dataclass
class AgentRun:
    """Enterprise-grade agent run with state machine, budget, and observability.

    Usage::

        run = AgentRun(budget=WorkBudget(max_tokens=100_000, max_steps=30))
        run.user_input = "Fix the login bug in auth.py"
        result = run.execute()
        print(run.state)  # RunState.COMPLETED
    """

    run_id: str = ""
    state: RunState = RunState.CREATED
    budget: WorkBudget | None = None
    budget_tracker: WorkBudgetTracker | None = None
    transaction: RunTransaction | None = None

    # Observability
    _created_at: float = 0.0
    _transition_log: list[dict] = field(default_factory=list)
    _on_state_change: Callable | None = None

    # Integration: set before execute()
    agent: Any = None
    user_input: str = ""
    extra_system: str = ""
    max_steps: int | None = None
    on_token: Callable | None = None
    resume_messages: list | None = None

    def __post_init__(self) -> None:
        if not self.run_id:
            import uuid
            self.run_id = uuid.uuid4().hex[:12]
        self._created_at = time.perf_counter()
        self._transition_log.append(
            {"state": self.state.value, "timestamp": time.time(), "reason": "created"}
        )

    # -- state management ----------------------------------------------------

    def transition(self, to_state: RunState, reason: str = "") -> None:
        """Perform a validated state transition."""
        if to_state not in _TRANSITIONS.get(self.state, set()):
            raise ValueError(
                f"Invalid state transition: {self.state.value} -> {to_state.value}. "
                f"Reason: {reason or 'not provided'}"
            )
        old = self.state
        self.state = to_state
        entry = {
            "from": old.value,
            "to": to_state.value,
            "timestamp": time.time(),
            "reason": reason,
        }
        self._transition_log.append(entry)
        if self._on_state_change:
            try:
                self._on_state_change(old, to_state, reason)
            except Exception:
                pass  # Callback failures must not affect the run

    def is_terminal(self) -> bool:
        return self.state in _TERMINAL_STATES

    # -- execution -----------------------------------------------------------

    def execute(self) -> RunResult:
        """Execute the full agentic run with state machine governance."""
        started = time.perf_counter()
        result = RunResult(run_id=self.run_id, state=self.state)

        try:
            # 1. Infrastructure setup
            if self.budget:
                self.budget_tracker = WorkBudgetTracker(self.budget)
                install_budget_hooks()
                self.budget_tracker.start()

            install_compaction_hook()
            reset_change_tracker()
            install_change_tracker_hook()
            reset_run_report()
            install_run_report_hook()
            reset_run_transaction()
            install_run_transaction_hook()
            # Learning system: record outcomes, inject relevant patterns
            try:
                from arforge.core.learning_hook import install_learning_hooks
                install_learning_hooks()
            except Exception:
                pass

            # Wire learning context into extra_system prompt for head-start injection
            try:
                from arforge.learning_system import inject as build_injection
                learning_ctx = build_injection(self.user_input)
                if learning_ctx:
                    if self.extra_system:
                        self.extra_system = self.extra_system + "\n\n" + learning_ctx
                    else:
                        self.extra_system = learning_ctx
            except Exception:
                pass

            self.transaction = get_run_transaction()

            # 2. Planning
            self.transition(RunState.PLANNING, "starting execution")

            # 3. Execution — delegate to existing tool loop
            self.transition(RunState.EXECUTING, "entering tool loop")

            from arforge.core.agent_loop_v2 import AgentLoopV2

            loop = AgentLoopV2(agent=self.agent)
            loop_result = loop.run_agentic(
                user_input=self.user_input,
                max_steps=self.max_steps,
                on_token=self.on_token,
                extra_system=self.extra_system,
                resume_messages=self.resume_messages,
            )

            # 4. Verification
            self.transition(RunState.VERIFYING, "checking results")

            # 5. Persist the recoverable run before assigning its terminal state.
            persist_run_transaction(self.run_id)
            save_run_messages(self.run_id, loop_result.messages)

            elapsed = round(time.perf_counter() - started, 3)
            report = get_run_report().to_dict() if get_run_report() else None

            result.answer = loop_result.answer
            result.intent = loop_result.intent
            result.tool_calls = loop_result.tool_calls
            result.trace = loop_result.trace
            result.steps = loop_result.steps
            result.elapsed_seconds = elapsed
            result.budget_used = self._budget_snapshot()
            result.budget_limit = self.budget.to_dict() if self.budget else {}
            result.report = report
            result.messages = loop_result.messages
            result.verifications = list(getattr(loop_result, "verifications", []) or [])
            result.incomplete_report = getattr(loop_result, "incomplete_report", None)
            result.observability = loop_result.observability

            if result.incomplete_report is not None:
                stop_reason = str(result.incomplete_report.get("stop_reason") or "incomplete")
                result.error = f"Agent loop stopped before completion: {stop_reason}"
                self.transition(RunState.INCOMPLETE, result.error)
                result.state = self.state
                try:
                    from arforge.core.dogfood import record_dogfood_outcome

                    record_dogfood_outcome(
                        task=self.user_input,
                        success=False,
                        error=result.error,
                        run_id=self.run_id,
                    )
                except Exception:
                    pass
            else:
                self.transition(RunState.COMPLETED, "execution finished successfully")
                result.state = self.state
                # Dogfood recording (learning data)
                try:
                    from arforge.core.dogfood import record_dogfood_outcome

                    record_dogfood_outcome(task=self.user_input, success=True, run_id=self.run_id)
                except Exception:
                    pass

        except KeyboardInterrupt:
            self.transition(RunState.INTERRUPTED, "user interrupted (Ctrl+C)")
            elapsed = round(time.perf_counter() - started, 3)
            result.state = self.state
            result.elapsed_seconds = elapsed
            result.error = "Interrupted by user"

        except Exception as exc:
            self.transition(RunState.FAILED, f"exception: {exc}")
            elapsed = round(time.perf_counter() - started, 3)
            result.state = self.state
            result.elapsed_seconds = elapsed
            result.error = str(exc)

            # Dogfood recording (failure)
            try:
                from arforge.core.dogfood import record_dogfood_outcome
                record_dogfood_outcome(task=self.user_input, success=False, error=str(exc), run_id=self.run_id)
            except Exception:
                pass

            # Attempt rollback on failure
            try:
                self.transition(RunState.ROLLING_BACK, f"rolling back after: {exc}")
                revert_run(self.run_id)
                result.rollback_events.append(
                    {"action": "rollback", "reason": str(exc), "success": True}
                )
            except Exception as rb_exc:
                result.rollback_events.append(
                    {"action": "rollback", "reason": str(exc), "success": False, "error": str(rb_exc)}
                )

        finally:
            if self.budget_tracker:
                self.budget_tracker.stop()
                result.budget_used = self.budget_tracker.snapshot()

        return result

    # -- budget helpers ------------------------------------------------------

    def _budget_snapshot(self) -> dict[str, int]:
        if not self.budget_tracker:
            return {}
        return self.budget_tracker.snapshot()

    # -- resume --------------------------------------------------------------

    @classmethod
    def resume(cls, run_id: str, messages: list) -> AgentRun:
        """Create an AgentRun primed for resumption from saved messages."""
        run = cls(run_id=run_id)
        run.resume_messages = messages
        # Note: already in CREATED from __post_init__, just log intent
        run._transition_log[-1]["reason"] = f"resuming run {run_id}"
        return run
