"""Compatibility adapters from existing Arforge views into Agent IR V2.

These functions deliberately reuse ``TaskLedger`` and current RunResult
verification dictionaries.  They do not introduce a second planner or test
runner; they provide a typed, replayable semantic view of existing behavior.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from arforge.core.cognitive_ir import Action, AgentTaskIR, Evidence, Verification
from arforge.core.task_ledger import COMPLETED, IN_PROGRESS, PENDING, TaskItem, TaskLedger


_PLAN_STATUSES = {PENDING, IN_PROGRESS, COMPLETED}
_SENSITIVE_KEYS = {
    "api_key",
    "authorization",
    "credential",
    "credentials",
    "output",
    "secret",
    "stderr",
    "stdout",
    "token",
}


def _next_record_id(task: AgentTaskIR, prefix: str) -> str:
    existing = {record.record_id for record in task.records}
    index = 1
    while f"{prefix}-{index:04d}" in existing:
        index += 1
    return f"{prefix}-{index:04d}"


def import_task_ledger(task: AgentTaskIR, ledger: TaskLedger) -> AgentTaskIR:
    """Append the current TaskLedger plan as typed ``plan_step`` actions."""
    projected = task
    for item in ledger.items():
        record_id = _next_record_id(projected, "plan-step")
        projected = projected.with_record(
            Action(
                record_id=record_id,
                action_type="plan_step",
                target=item.content,
                status=item.status if item.status in _PLAN_STATUSES else PENDING,
                risk_level="low",
            )
        )
    return projected


def sync_task_ledger(task: AgentTaskIR, ledger: TaskLedger) -> None:
    """Replace the existing ledger with Agent IR ``plan_step`` actions."""
    items = []
    for record in task.records:
        if isinstance(record, Action) and record.action_type == "plan_step":
            status = record.status if record.status in _PLAN_STATUSES else PENDING
            items.append(TaskItem(content=record.target, status=status))
    ledger.replace(items)


def _bounded_metadata(item: Mapping[str, Any]) -> dict[str, Any]:
    """Retain small audit metadata while excluding likely raw/sensitive output."""
    result: dict[str, Any] = {}
    for key, value in item.items():
        normalized = str(key).casefold()
        if normalized in _SENSITIVE_KEYS or key in {"criterion", "passed", "tool"}:
            continue
        if isinstance(value, (str, int, float, bool, type(None))):
            result[str(key)] = value[:2_000] if isinstance(value, str) else value
    return result


def import_run_verifications(
    task: AgentTaskIR,
    verifications: Iterable[Mapping[str, Any]],
) -> AgentTaskIR:
    """Append evidence-linked verification records from an existing RunResult."""
    projected = task
    for raw in verifications:
        if not isinstance(raw, Mapping):
            raise TypeError("verification entries must be mappings")
        tool = str(raw.get("tool") or raw.get("verifier") or "runtime").strip() or "runtime"
        passed = bool(raw.get("passed", False))
        criterion = str(raw.get("criterion") or f"{tool} succeeds").strip()
        evidence_id = _next_record_id(projected, "run-verification-evidence")
        verification_id = _next_record_id(projected, "run-verification")
        step = raw.get("step")
        suffix = f" at step {step}" if isinstance(step, int) else ""
        projected = projected.with_record(
            Evidence(
                record_id=evidence_id,
                summary=f"{tool} {'passed' if passed else 'failed'}{suffix}",
                source=f"run_result:{tool}",
                evidence_type="verification_result",
                authority=1.0,
                sensitivity="internal",
                extensions={"arforge.run_result": _bounded_metadata(raw)},
            )
        )
        projected = projected.with_record(
            Verification(
                record_id=verification_id,
                criterion=criterion,
                verifier=tool,
                status="passed" if passed else "failed",
                evidence_ids=(evidence_id,),
            )
        )
    return projected


__all__ = ["import_run_verifications", "import_task_ledger", "sync_task_ledger"]
