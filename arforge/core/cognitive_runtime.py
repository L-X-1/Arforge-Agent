"""Deterministic projection helpers for Agent IR runtime events."""

from __future__ import annotations

from dataclasses import replace
from typing import Iterable

from arforge.core.cognitive_ir import (
    AgentTaskIR,
    IRValidationError,
    LifecycleState,
    record_from_dict,
)
from arforge.core.cognitive_lifecycle import transition_allowed
from arforge.core.run_event_journal import RunEvent


_CRITICAL_PREFIXES = ("task.", "state.", "record.", "checkpoint.", "rollback.")


def replay_cognitive_events(events: Iterable[RunEvent]) -> AgentTaskIR:
    """Verify event semantics and rebuild one deterministic Agent IR projection."""
    task: AgentTaskIR | None = None
    for event in events:
        path = f"events[{event.sequence}]"
        payload = event.payload
        if event.event_type == "task.created":
            if task is not None:
                raise IRValidationError(path, "task.created may only appear once")
            if event.sequence != 0:
                raise IRValidationError(path, "task.created must be the first event")
            raw_task = payload.get("task")
            if not isinstance(raw_task, dict):
                raise IRValidationError(f"{path}.payload.task", "must be an Agent IR object")
            task = AgentTaskIR.from_dict(raw_task)
            continue

        if task is None:
            raise IRValidationError(path, "event appears before task.created")

        if event.event_type == "state.transitioned":
            declared_from = str(payload.get("from", ""))
            if declared_from != task.state.value:
                raise IRValidationError(
                    f"{path}.payload.from",
                    f"expected {task.state.value!r}, got {declared_from!r}",
                )
            try:
                target = LifecycleState(str(payload.get("to", "")))
            except ValueError as exc:
                raise IRValidationError(
                    f"{path}.payload.to",
                    f"unknown lifecycle state {payload.get('to')!r}",
                ) from exc
            lifecycle_mode = str(payload.get("lifecycle_mode", "governed"))
            if lifecycle_mode not in {"governed", "compatibility"}:
                raise IRValidationError(
                    f"{path}.payload.lifecycle_mode",
                    f"unknown lifecycle mode {lifecycle_mode!r}",
                )
            if not transition_allowed(
                task.state.value,
                target.value,
                governed=lifecycle_mode == "governed",
            ):
                raise IRValidationError(
                    f"{path}.payload.to",
                    f"illegal lifecycle transition {task.state.value} -> {target.value}",
                )
            task = task.with_state(target, updated_at=event.timestamp)
            continue

        if event.event_type == "record.upserted":
            raw_record = payload.get("record")
            if not isinstance(raw_record, dict):
                raise IRValidationError(f"{path}.payload.record", "must be a record object")
            record = record_from_dict(raw_record)
            existing_index = next(
                (index for index, item in enumerate(task.records) if item.record_id == record.record_id),
                None,
            )
            if existing_index is None:
                task = task.with_record(record, updated_at=event.timestamp)
            else:
                existing = task.records[existing_index]
                if existing.kind != record.kind:
                    raise IRValidationError(
                        f"{path}.payload.record.kind",
                        f"cannot replace {existing.kind!r} with {record.kind!r}",
                    )
                records = list(task.records)
                records[existing_index] = record
                task = replace(
                    task,
                    records=tuple(records),
                    revision=task.revision + 1,
                    updated_at=event.timestamp,
                )
                task.validate()
            continue

        if event.event_type == "record.status_changed":
            record_id = str(payload.get("record_id", ""))
            try:
                existing_index = next(
                    index for index, item in enumerate(task.records) if item.record_id == record_id
                )
            except StopIteration as exc:
                raise IRValidationError(
                    f"{path}.payload.record_id",
                    f"references missing record {record_id!r}",
                ) from exc
            existing = task.records[existing_index]
            declared_from = str(payload.get("from", ""))
            if declared_from != existing.status:
                raise IRValidationError(
                    f"{path}.payload.from",
                    f"expected {existing.status!r}, got {declared_from!r}",
                )
            records = list(task.records)
            records[existing_index] = replace(existing, status=str(payload.get("to", "")))
            task = replace(
                task,
                records=tuple(records),
                revision=task.revision + 1,
                updated_at=event.timestamp,
            )
            task.validate()
            continue

        if event.event_type == "checkpoint.created":
            # A checkpoint is recovery acceleration, not semantic task state.
            continue

        if event.event_type == "rollback.recorded":
            if task.state is not LifecycleState.ROLLING_BACK:
                raise IRValidationError(
                    f"{path}.payload",
                    "rollback audit event requires rolling_back task state",
                )
            status = str(payload.get("status", ""))
            if status not in {"succeeded", "failed"}:
                raise IRValidationError(
                    f"{path}.payload.status",
                    f"unknown rollback status {status!r}",
                )
            source_state = str(payload.get("source_state", ""))
            if source_state not in {"failed", "interrupted"}:
                raise IRValidationError(
                    f"{path}.payload.source_state",
                    f"unknown rollback source state {source_state!r}",
                )
            if not str(payload.get("restored_point", "")).strip():
                raise IRValidationError(
                    f"{path}.payload.restored_point",
                    "must be a non-empty rollback point",
                )
            if status == "failed" and not str(payload.get("error", "")).strip():
                raise IRValidationError(
                    f"{path}.payload.error",
                    "is required for a failed rollback",
                )
            continue

        if event.event_type.startswith(_CRITICAL_PREFIXES):
            raise IRValidationError(path, f"unknown safety-critical event type {event.event_type!r}")
        # Unknown namespaced non-critical events remain in the verified journal
        # for audit and are ignored by this older projector deterministically.

    if task is None:
        raise IRValidationError("events", "missing task.created event")
    task.validate()
    return task


__all__ = ["replay_cognitive_events"]
