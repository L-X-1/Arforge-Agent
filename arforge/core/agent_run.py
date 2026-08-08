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
from pathlib import Path
from typing import Any, Callable

from arforge.core.budget import (
    WorkBudget,
    WorkBudgetTracker,
    install_budget_hooks,
)
from arforge.core.change_tracker import install_change_tracker_hook, reset_change_tracker
from arforge.core.compaction import install_compaction_hook
from arforge.core.cognitive_lifecycle import (
    COMPATIBILITY_TRANSITIONS,
    GOVERNED_TRANSITIONS,
)
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
    UNDERSTANDING = "understanding"
    PLANNING = "planning"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    COMPACTING = "compacting"
    BLOCKED = "blocked"
    WAITING_APPROVAL = "waiting_approval"
    LEARNING = "learning"
    COMPLETED = "completed"
    INCOMPLETE = "incomplete"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    ROLLING_BACK = "rolling_back"
    ROLLED_BACK = "rolled_back"


# Terminal states
_TERMINAL_STATES = {
    RunState.COMPLETED,
    RunState.INCOMPLETE,
    RunState.FAILED,
    RunState.INTERRUPTED,
    RunState.ROLLED_BACK,
}

def _run_state_graph(raw: dict[str, frozenset[str]]) -> dict[RunState, set[RunState]]:
    # Keep ROLLED_BACK absent from this compatibility export. Existing tests
    # and callers treat missing entries as terminal with no outgoing edge.
    return {
        RunState(state): {RunState(target) for target in targets}
        for state, targets in raw.items()
        if state != RunState.ROLLED_BACK.value
    }


# Public compatibility name retained for existing imports/tests. The canonical
# string graphs live in cognitive_lifecycle.py and are also used by replay.
_TRANSITIONS = _run_state_graph(COMPATIBILITY_TRANSITIONS)
_GOVERNED_TRANSITIONS = _run_state_graph(GOVERNED_TRANSITIONS)


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
    cognitive_state: dict | None = None
    cognitive_events: list[dict] = field(default_factory=list)
    structured_checkpoint: dict | None = None


def _dogfood_payload(result: RunResult, loop_result: Any | None, elapsed: float) -> dict:
    """从 run 结果提取 dogfood 遥测字段（None 安全，异常路径 loop_result 可能缺失）。

    返回键与 ``record_dogfood_outcome`` 关键字参数对齐，调用方补 task/success/error 即可展开。
    """
    incomplete: dict = {}
    if loop_result is not None:
        raw_incomplete = getattr(loop_result, "incomplete_report", None)
        if isinstance(raw_incomplete, dict):
            incomplete = raw_incomplete
    if not incomplete and isinstance(result.incomplete_report, dict):
        incomplete = result.incomplete_report

    loop_tool_calls = (
        getattr(loop_result, "tool_calls", None)
        if loop_result is not None
        else None
    )
    if isinstance(loop_tool_calls, list) and loop_tool_calls:
        tool_calls = len(loop_tool_calls)
        failed_tool_calls = sum(
            1
            for call in loop_tool_calls
            if isinstance(call, dict) and call.get("success") is False
        )
    elif isinstance(result.tool_calls, list) and result.tool_calls:
        tool_calls = len(result.tool_calls)
        failed_tool_calls = sum(
            1
            for call in result.tool_calls
            if isinstance(call, dict) and call.get("success") is False
        )
    else:
        tool_calls = int(incomplete.get("tools_called", 0) or 0)
        failed_tool_calls = 0
    if isinstance(incomplete.get("failures"), int):
        failed_tool_calls = int(incomplete["failures"])

    steps = (
        int(getattr(loop_result, "steps", 0) or 0)
        if loop_result is not None
        else int(result.steps or 0)
    )

    budget = result.budget_used if isinstance(result.budget_used, dict) else {}
    tokens = int(budget.get("tokens_used") or budget.get("tokens") or 0)
    cost_cny = float(budget.get("cost_cny") or 0.0)

    report = result.report if isinstance(result.report, dict) else {}
    modified_files = len(report.get("modified_files") or [])

    verifications: list[dict] = []
    if loop_result is not None:
        raw_verifications = getattr(loop_result, "verifications", None)
        if isinstance(raw_verifications, list):
            verifications = [v for v in raw_verifications if isinstance(v, dict)]
    if not verifications:
        verifications = [v for v in result.verifications if isinstance(v, dict)]
    verification_passed = any(v.get("passed") is True for v in verifications)
    verification_records: list[dict] = []
    for record in verifications:
        safe = {}
        for key, value in record.items():
            if isinstance(value, (str, int, float, bool)) or value is None:
                safe[key] = value
            else:
                safe[key] = str(value)
        verification_records.append(safe)

    return {
        "run_id": result.run_id,
        "steps": steps,
        "tool_calls": tool_calls,
        "failed_tool_calls": failed_tool_calls,
        "tokens": tokens,
        "cost_cny": cost_cny,
        "modified_files": modified_files,
        "duration_seconds": float(elapsed or 0.0),
        "stop_reason": str(incomplete.get("stop_reason") or ""),
        "max_steps": int(incomplete.get("max_steps") or 0),
        "verification_passed": verification_passed,
        "verification": {"records": verification_records} if verification_records else {},
    }


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

    # Additive cognitive runtime. Existing callers remain in compatibility
    # mode unless they opt into the governed lifecycle.
    governed_lifecycle: bool = False
    cognitive_persistence_root: str | Path | None = None
    cognitive_task: Any = None
    _cognitive_journal: Any = None
    _cognitive_events: list[Any] = field(default_factory=list)
    _last_structured_checkpoint: Any = None

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
        transition_graph = _GOVERNED_TRANSITIONS if self.governed_lifecycle else _TRANSITIONS
        if to_state not in transition_graph.get(self.state, set()):
            raise ValueError(
                f"Invalid state transition: {self.state.value} -> {to_state.value}. "
                f"Reason: {reason or 'not provided'}"
            )
        old = self.state
        cognitive_event = None
        if self.cognitive_task is not None:
            if self.cognitive_task.state.value != old.value:
                raise ValueError(
                    "Cognitive projection state diverged from AgentRun: "
                    f"{self.cognitive_task.state.value} != {old.value}"
                )
            cognitive_event = self._emit_cognitive_event(
                "state.transitioned",
                {
                    "from": old.value,
                    "to": to_state.value,
                    "reason": reason,
                    "task_revision": self.cognitive_task.revision,
                    "lifecycle_mode": (
                        "governed" if self.governed_lifecycle else "compatibility"
                    ),
                },
            )
            self.cognitive_task = self.cognitive_task.with_state(
                to_state.value,
                updated_at=cognitive_event.timestamp,
            )
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

    # -- cognitive runtime --------------------------------------------------

    @property
    def cognitive_events(self) -> tuple[Any, ...]:
        if self._cognitive_journal is not None:
            return self._cognitive_journal.read_verified()
        return tuple(self._cognitive_events)

    def enable_cognitive_runtime(
        self,
        objective: str,
        *,
        task_id: str | None = None,
    ) -> Any:
        """Create or restore the Agent IR projection for this run."""
        from arforge.core.cognitive_ir import AgentTaskIR
        from arforge.core.cognitive_runtime import replay_cognitive_events
        from arforge.core.run_event_journal import RunEventJournal

        if self.cognitive_task is not None:
            return self.cognitive_task
        if self.cognitive_persistence_root is not None:
            root = Path(self.cognitive_persistence_root)
            self._cognitive_journal = RunEventJournal(
                root / self.run_id / "events.jsonl",
                run_id=self.run_id,
            )
            existing = self._cognitive_journal.read_verified()
            if existing:
                self.cognitive_task = replay_cognitive_events(existing)
                self.state = RunState(self.cognitive_task.state.value)
                return self.cognitive_task
        self.cognitive_task = AgentTaskIR.create(
            objective,
            task_id=task_id or f"task-{self.run_id}",
        )
        self._emit_cognitive_event("task.created", {"task": self.cognitive_task.to_dict()})
        return self.cognitive_task

    def restore_cognitive_runtime(self) -> Any:
        """Restore an existing durable projection without fabricating a task."""
        if self.cognitive_persistence_root is None:
            raise ValueError("cognitive_persistence_root is required for restore")
        from arforge.core.cognitive_runtime import replay_cognitive_events
        from arforge.core.run_event_journal import RunEventJournal

        root = Path(self.cognitive_persistence_root)
        journal = RunEventJournal(root / self.run_id / "events.jsonl", run_id=self.run_id)
        events = journal.read_verified()
        if not events:
            raise FileNotFoundError(f"no cognitive events for run {self.run_id!r}")
        self._cognitive_journal = journal
        self.cognitive_task = replay_cognitive_events(events)
        self.state = RunState(self.cognitive_task.state.value)
        return self.cognitive_task

    def _emit_cognitive_event(
        self,
        event_type: str,
        payload: dict[str, Any],
        *,
        actor: str = "runtime",
    ) -> Any:
        from arforge.core.run_event_journal import RunEvent

        if self._cognitive_journal is not None:
            position = self._cognitive_journal.last_position()
            return self._cognitive_journal.append(
                event_type,
                payload,
                actor=actor,
                expected_last_sequence=position.sequence,
            )
        previous = self._cognitive_events[-1].checksum if self._cognitive_events else ""
        event = RunEvent.create(
            run_id=self.run_id,
            sequence=len(self._cognitive_events),
            event_type=event_type,
            payload=payload,
            previous_checksum=previous,
            actor=actor,
        )
        self._cognitive_events.append(event)
        return event

    def _append_cognitive_record(self, record: Any) -> None:
        if self.cognitive_task is None:
            return
        # Validate the candidate before making the event durable.
        self.cognitive_task.with_record(record)
        event = self._emit_cognitive_event("record.upserted", {"record": record.to_dict()})
        self.cognitive_task = self.cognitive_task.with_record(
            record,
            updated_at=event.timestamp,
        )

    # -- execution -----------------------------------------------------------

    def execute(self) -> RunResult:
        """Execute the full agentic run with state machine governance."""
        started = time.perf_counter()
        result = RunResult(run_id=self.run_id, state=self.state)
        loop_result: Any | None = None

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

            if self.governed_lifecycle or self.cognitive_persistence_root is not None:
                self.enable_cognitive_runtime(
                    self.user_input or f"Agent run {self.run_id}",
                    task_id=f"task-{self.run_id}",
                )

            # 2. Planning
            if self.governed_lifecycle:
                self.transition(RunState.UNDERSTANDING, "understanding objective")
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

            # Governed runs fail closed when the execution loop supplies an
            # explicit failed verification but forgets to build its normal
            # incomplete report. Absence of verification records remains
            # compatible with read-only/general tasks that have no declared
            # completion criterion.
            failed_verifications = [
                verification
                for verification in result.verifications
                if verification.get("passed") is False
                and verification.get("waived") is not True
            ]
            if (
                self.governed_lifecycle
                and failed_verifications
                and result.incomplete_report is None
            ):
                remaining = []
                for verification in failed_verifications:
                    criterion = str(
                        verification.get("criterion")
                        or verification.get("tool")
                        or "unresolved verification"
                    ).strip()
                    if criterion and criterion not in remaining:
                        remaining.append(criterion)
                result.incomplete_report = {
                    "stop_reason": "verification_failed",
                    "remaining": remaining,
                }

            if self.cognitive_task is not None and result.verifications:
                from arforge.core.cognitive_adapters import import_run_verifications

                projected = import_run_verifications(self.cognitive_task, result.verifications)
                for record in projected.records[len(self.cognitive_task.records):]:
                    self._append_cognitive_record(record)

            if result.incomplete_report is not None:
                stop_reason = str(result.incomplete_report.get("stop_reason") or "incomplete")
                result.error = f"Agent loop stopped before completion: {stop_reason}"
                self._save_cognitive_checkpoint(result)
                self.transition(RunState.INCOMPLETE, result.error)
                result.state = self.state
                try:
                    from arforge.core.dogfood import record_dogfood_outcome

                    payload = _dogfood_payload(result, loop_result, elapsed)
                    record_dogfood_outcome(
                        task=self.user_input,
                        success=False,
                        error=result.error or "",
                        **payload,
                    )
                    from arforge.core.runtime_metrics import RunMetrics, get_metrics

                    get_metrics().record_run(
                        RunMetrics(
                            task=self.user_input,
                            success=False,
                            steps=payload["steps"],
                            tool_calls=payload["tool_calls"],
                            failed_tool_calls=payload["failed_tool_calls"],
                            tokens_total=payload["tokens"],
                            cost_cny=payload["cost_cny"],
                            elapsed_ms=round(payload["duration_seconds"] * 1000, 1),
                            modified_files=payload["modified_files"],
                            verifications=len(
                                payload["verification"].get("records", [])
                                if isinstance(payload["verification"], dict)
                                else []
                            ),
                            run_id=self.run_id,
                        )
                    )
                except Exception:
                    pass
            else:
                if self.governed_lifecycle:
                    self.transition(RunState.LEARNING, "capturing verified outcome")
                self._save_cognitive_checkpoint(result)
                self.transition(RunState.COMPLETED, "execution finished successfully")
                result.state = self.state
                # Dogfood recording (learning data)
                try:
                    from arforge.core.dogfood import record_dogfood_outcome

                    payload = _dogfood_payload(result, loop_result, elapsed)
                    record_dogfood_outcome(
                        task=self.user_input,
                        success=True,
                        **payload,
                    )
                    from arforge.core.runtime_metrics import RunMetrics, get_metrics

                    get_metrics().record_run(
                        RunMetrics(
                            task=self.user_input,
                            success=True,
                            steps=payload["steps"],
                            tool_calls=payload["tool_calls"],
                            failed_tool_calls=payload["failed_tool_calls"],
                            tokens_total=payload["tokens"],
                            cost_cny=payload["cost_cny"],
                            elapsed_ms=round(payload["duration_seconds"] * 1000, 1),
                            modified_files=payload["modified_files"],
                            verifications=len(
                                payload["verification"].get("records", [])
                                if isinstance(payload["verification"], dict)
                                else []
                            ),
                            run_id=self.run_id,
                        )
                    )
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

                payload = _dogfood_payload(result, loop_result, elapsed)
                record_dogfood_outcome(
                    task=self.user_input,
                    success=False,
                    error=str(exc),
                    **payload,
                )
                from arforge.core.runtime_metrics import RunMetrics, get_metrics

                get_metrics().record_run(
                    RunMetrics(
                        task=self.user_input,
                        success=False,
                        steps=payload["steps"],
                        tool_calls=payload["tool_calls"],
                        failed_tool_calls=payload["failed_tool_calls"],
                        tokens_total=payload["tokens"],
                        cost_cny=payload["cost_cny"],
                        elapsed_ms=round(payload["duration_seconds"] * 1000, 1),
                        modified_files=payload["modified_files"],
                        verifications=len(
                            payload["verification"].get("records", [])
                            if isinstance(payload["verification"], dict)
                            else []
                        ),
                        run_id=self.run_id,
                    )
                )
            except Exception:
                pass

            # Attempt rollback on failure
            try:
                self.transition(RunState.ROLLING_BACK, f"rolling back after: {exc}")
                revert_run(self.run_id)
                if self.cognitive_task is not None:
                    self._emit_cognitive_event(
                        "rollback.recorded",
                        {
                            "source_state": "failed",
                            "restored_point": f"run:{self.run_id}",
                            "status": "succeeded",
                        },
                    )
                self.transition(RunState.ROLLED_BACK, f"rollback completed after: {exc}")
                result.state = self.state
                result.rollback_events.append(
                    {"action": "rollback", "reason": str(exc), "success": True}
                )
            except Exception as rb_exc:
                if self.cognitive_task is not None and self.state is RunState.ROLLING_BACK:
                    self._emit_cognitive_event(
                        "rollback.recorded",
                        {
                            "source_state": "failed",
                            "restored_point": f"run:{self.run_id}",
                            "status": "failed",
                            "error": str(rb_exc)[:2048],
                        },
                    )
                if self.state is RunState.ROLLING_BACK:
                    self.transition(RunState.FAILED, f"rollback failed: {rb_exc}")
                result.state = self.state
                result.rollback_events.append(
                    {"action": "rollback", "reason": str(exc), "success": False, "error": str(rb_exc)}
                )

            try:
                self._save_cognitive_checkpoint(result)
            except Exception as checkpoint_exc:
                result.rollback_events.append(
                    {
                        "action": "cognitive_checkpoint",
                        "reason": str(exc),
                        "success": False,
                        "error": str(checkpoint_exc),
                    }
                )

        finally:
            if self.budget_tracker:
                self.budget_tracker.stop()
                result.budget_used = self.budget_tracker.snapshot()
            if self.cognitive_task is not None:
                result.cognitive_state = self.cognitive_task.to_dict()
                result.cognitive_events = [event.to_dict() for event in self.cognitive_events]
            if self._last_structured_checkpoint is not None:
                result.structured_checkpoint = self._last_structured_checkpoint.to_dict()

        return result

    def _save_cognitive_checkpoint(self, result: RunResult) -> None:
        if (
            self.cognitive_task is None
            or self._cognitive_journal is None
            or self.cognitive_persistence_root is None
        ):
            return
        from arforge.core.cognitive_ir import Action
        from arforge.core.structured_checkpoint import StructuredCheckpointStore

        completed: list[str] = []
        unresolved: list[str] = []
        next_actions: list[str] = []
        for record in self.cognitive_task.records:
            if not isinstance(record, Action) or record.action_type != "plan_step":
                continue
            if record.status == "completed":
                completed.append(record.target)
            else:
                unresolved.append(record.target)
                if record.status == "pending":
                    next_actions.append(record.target)
        report = result.report or {}
        files_touched = tuple(
            str(path)
            for path in report.get("modified_files", [])
            if str(path).strip()
        )
        store = StructuredCheckpointStore(
            Path(self.cognitive_persistence_root),
            run_id=self.run_id,
        )
        self._last_structured_checkpoint = store.save(
            self.cognitive_task,
            self._cognitive_journal,
            completed=tuple(completed),
            unresolved=tuple(unresolved),
            next_actions=tuple(next_actions),
            files_touched=files_touched,
            budget=result.budget_used,
            rollback_point=f"run:{self.run_id}",
            messages=tuple(
                dict(message)
                for message in result.messages
                if isinstance(message, dict)
            ),
        )

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
