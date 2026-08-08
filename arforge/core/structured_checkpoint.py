"""Versioned semantic checkpoints tied to verified cognitive journals."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Mapping

from arforge.core.cognitive_ir import AgentTaskIR, canonical_json_bytes, utc_now
from arforge.core.run_event_journal import RunEventJournal


CHECKPOINT_SCHEMA_VERSION = "2.0"
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CHECKSUM = re.compile(r"^sha256:[0-9a-f]{64}$")


class CheckpointError(RuntimeError):
    """Base error for semantic checkpoint operations."""


class CheckpointIntegrityError(CheckpointError):
    """A checkpoint document is malformed or its digest is invalid."""


class CheckpointConsistencyError(CheckpointError):
    """A valid checkpoint does not point into its verified event journal."""


@dataclass(frozen=True)
class StructuredCheckpoint:
    """Full Agent IR projection plus explicit task-recovery context."""

    checkpoint_id: str
    run_id: str
    created_at: str
    event_sequence: int
    event_checksum: str
    task: AgentTaskIR
    completed: tuple[str, ...] = ()
    unresolved: tuple[str, ...] = ()
    next_actions: tuple[str, ...] = ()
    files_touched: tuple[str, ...] = ()
    budget: dict[str, Any] = field(default_factory=dict)
    rollback_point: str = ""
    messages: tuple[dict[str, Any], ...] = ()
    extensions: dict[str, Any] = field(default_factory=dict)
    digest: str = ""
    schema_version: str = CHECKPOINT_SCHEMA_VERSION

    @classmethod
    def create(
        cls,
        *,
        run_id: str,
        event_sequence: int,
        event_checksum: str,
        task: AgentTaskIR,
        completed: tuple[str, ...] = (),
        unresolved: tuple[str, ...] = (),
        next_actions: tuple[str, ...] = (),
        files_touched: tuple[str, ...] = (),
        budget: Mapping[str, Any] | None = None,
        rollback_point: str = "",
        messages: tuple[dict[str, Any], ...] = (),
        extensions: Mapping[str, Any] | None = None,
        checkpoint_id: str | None = None,
        created_at: str | None = None,
    ) -> "StructuredCheckpoint":
        checkpoint = cls(
            checkpoint_id=checkpoint_id or f"checkpoint-{uuid.uuid4().hex}",
            run_id=run_id,
            created_at=created_at or utc_now(),
            event_sequence=event_sequence,
            event_checksum=event_checksum,
            task=task,
            completed=tuple(completed),
            unresolved=tuple(unresolved),
            next_actions=tuple(next_actions),
            files_touched=tuple(files_touched),
            budget=dict(budget or {}),
            rollback_point=rollback_point,
            messages=tuple(dict(message) for message in messages),
            extensions=dict(extensions or {}),
        )
        checkpoint = replace(checkpoint, digest=checkpoint.expected_digest())
        checkpoint.validate()
        return checkpoint

    def body_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "checkpoint_id": self.checkpoint_id,
            "run_id": self.run_id,
            "created_at": self.created_at,
            "event_sequence": self.event_sequence,
            "event_checksum": self.event_checksum,
            "task": self.task.to_dict(),
            "completed": list(self.completed),
            "unresolved": list(self.unresolved),
            "next_actions": list(self.next_actions),
            "files_touched": list(self.files_touched),
            "budget": self.budget,
            "rollback_point": self.rollback_point,
            "messages": list(self.messages),
            "extensions": self.extensions,
        }

    def to_dict(self) -> dict[str, Any]:
        self.validate()
        return {**self.body_dict(), "digest": self.digest}

    def expected_digest(self) -> str:
        raw = canonical_json_bytes(self.body_dict())
        return f"sha256:{hashlib.sha256(raw).hexdigest()}"

    def validate(self) -> None:
        if self.schema_version != CHECKPOINT_SCHEMA_VERSION:
            raise CheckpointIntegrityError(
                f"schema_version: unsupported value {self.schema_version!r}"
            )
        for name, value in (("checkpoint_id", self.checkpoint_id), ("run_id", self.run_id)):
            if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
                raise CheckpointIntegrityError(f"{name}: invalid identifier")
        if not self.created_at.strip():
            raise CheckpointIntegrityError("created_at: must not be empty")
        if (
            isinstance(self.event_sequence, bool)
            or not isinstance(self.event_sequence, int)
            or self.event_sequence < 0
        ):
            raise CheckpointIntegrityError("event_sequence: must be a non-negative integer")
        if not _CHECKSUM.fullmatch(self.event_checksum):
            raise CheckpointIntegrityError("event_checksum: invalid checksum")
        self.task.validate()
        for field_name in ("completed", "unresolved", "next_actions", "files_touched"):
            values = getattr(self, field_name)
            for index, value in enumerate(values):
                if not isinstance(value, str) or not value.strip():
                    raise CheckpointIntegrityError(
                        f"{field_name}[{index}]: must be a non-empty string"
                    )
        canonical_json_bytes(self.budget)
        canonical_json_bytes(list(self.messages))
        canonical_json_bytes(self.extensions)
        if not _CHECKSUM.fullmatch(self.digest):
            raise CheckpointIntegrityError("digest: invalid checksum")
        expected = self.expected_digest()
        if self.digest != expected:
            raise CheckpointIntegrityError(
                f"digest mismatch for {self.checkpoint_id}: expected {expected}, got {self.digest}"
            )

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "StructuredCheckpoint":
        if not isinstance(data, Mapping):
            raise CheckpointIntegrityError("checkpoint document must be an object")
        if str(data.get("schema_version", "")) != CHECKPOINT_SCHEMA_VERSION:
            raise CheckpointIntegrityError(
                f"schema_version: unsupported value {data.get('schema_version')!r}"
            )
        try:
            messages = data.get("messages", [])
            if not isinstance(messages, list) or not all(isinstance(item, Mapping) for item in messages):
                raise TypeError("messages must be an array of objects")
            checkpoint = cls(
                schema_version=str(data["schema_version"]),
                checkpoint_id=str(data["checkpoint_id"]),
                run_id=str(data["run_id"]),
                created_at=str(data["created_at"]),
                event_sequence=data["event_sequence"],
                event_checksum=str(data["event_checksum"]),
                task=AgentTaskIR.from_dict(data["task"]),
                completed=tuple(str(item) for item in data.get("completed", [])),
                unresolved=tuple(str(item) for item in data.get("unresolved", [])),
                next_actions=tuple(str(item) for item in data.get("next_actions", [])),
                files_touched=tuple(str(item) for item in data.get("files_touched", [])),
                budget=dict(data.get("budget", {})),
                rollback_point=str(data.get("rollback_point", "")),
                messages=tuple(dict(item) for item in messages),
                extensions=dict(data.get("extensions", {})),
                digest=str(data["digest"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise CheckpointIntegrityError(f"invalid checkpoint shape: {exc}") from exc
        checkpoint.validate()
        return checkpoint


@dataclass(frozen=True)
class CheckpointLoadResult:
    checkpoint: StructuredCheckpoint
    fallback_used: bool = False
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class LegacyCheckpointView:
    """Explicit non-semantic view of an existing message-only checkpoint."""

    run_id: str
    objective: str
    messages: tuple[dict[str, Any], ...]
    status: str
    steps_completed: int = 0
    tokens_used: int = 0
    semantic_state_available: bool = False
    agent_ir: None = None
    warning: str = (
        "No beliefs, hypotheses, decisions, or verification records were inferred "
        "from the legacy conversation."
    )


def migrate_legacy_checkpoint(value: Any) -> LegacyCheckpointView:
    """Preserve a legacy checkpoint without fabricating Agent IR semantics."""
    if isinstance(value, Mapping):
        data = dict(value)
    elif hasattr(value, "to_dict"):
        data = dict(value.to_dict())
    else:
        raise TypeError("legacy checkpoint must be a mapping or expose to_dict()")
    raw_messages = data.get("messages", [])
    if not isinstance(raw_messages, list) or not all(isinstance(item, Mapping) for item in raw_messages):
        raise TypeError("legacy messages must be an array of objects")
    return LegacyCheckpointView(
        run_id=str(data.get("run_id", "")),
        objective=str(data.get("task", data.get("objective", ""))),
        messages=tuple(dict(item) for item in raw_messages),
        status=str(data.get("status", "unknown")),
        steps_completed=int(data.get("steps_completed", 0) or 0),
        tokens_used=int(data.get("tokens_used", 0) or 0),
    )


class StructuredCheckpointStore:
    """Atomic, retained structured checkpoints for one run."""

    def __init__(self, root: str | Path, *, run_id: str, retention: int = 5) -> None:
        if not _IDENTIFIER.fullmatch(run_id):
            raise ValueError("run_id has an invalid identifier")
        self.root = Path(root)
        self.run_id = run_id
        self.retention = max(1, int(retention))
        self.checkpoint_dir = self.root / run_id / "checkpoints"

    def list_versions(self) -> tuple[Path, ...]:
        if not self.checkpoint_dir.exists():
            return ()
        return tuple(sorted(self.checkpoint_dir.glob("*.json")))

    def save(
        self,
        task: AgentTaskIR,
        journal: RunEventJournal,
        *,
        completed: tuple[str, ...] = (),
        unresolved: tuple[str, ...] = (),
        next_actions: tuple[str, ...] = (),
        files_touched: tuple[str, ...] = (),
        budget: Mapping[str, Any] | None = None,
        rollback_point: str = "",
        messages: tuple[dict[str, Any], ...] = (),
        extensions: Mapping[str, Any] | None = None,
        created_at: str | None = None,
    ) -> StructuredCheckpoint:
        if journal.run_id != self.run_id:
            raise CheckpointConsistencyError(
                f"journal run_id {journal.run_id!r} does not match store {self.run_id!r}"
            )
        position = journal.last_position()
        if position.sequence < 0:
            raise CheckpointConsistencyError("cannot checkpoint a run with an empty journal")
        checkpoint = StructuredCheckpoint.create(
            run_id=self.run_id,
            event_sequence=position.sequence,
            event_checksum=position.checksum,
            task=task,
            completed=completed,
            unresolved=unresolved,
            next_actions=next_actions,
            files_touched=files_touched,
            budget=budget,
            rollback_point=rollback_point,
            messages=messages,
            extensions=extensions,
            created_at=created_at,
        )
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{time.time_ns():020d}-{checkpoint.checkpoint_id}.json"
        target = self.checkpoint_dir / filename
        temporary = self.checkpoint_dir / f".{filename}.{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("wb") as stream:
                stream.write(canonical_json_bytes(checkpoint.to_dict()) + b"\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            journal.append(
                "checkpoint.created",
                {
                    "checkpoint_id": checkpoint.checkpoint_id,
                    "digest": checkpoint.digest,
                    "event_sequence": checkpoint.event_sequence,
                    "event_checksum": checkpoint.event_checksum,
                },
                expected_last_sequence=position.sequence,
            )
        except Exception:
            temporary.unlink(missing_ok=True)
            target.unlink(missing_ok=True)
            raise
        self._prune()
        return checkpoint

    def load_latest(self, journal: RunEventJournal) -> CheckpointLoadResult:
        if journal.run_id != self.run_id:
            raise CheckpointConsistencyError(
                f"journal run_id {journal.run_id!r} does not match store {self.run_id!r}"
            )
        versions = list(reversed(self.list_versions()))
        if not versions:
            raise FileNotFoundError(f"no structured checkpoints for run {self.run_id!r}")
        events = journal.read_verified()
        warnings: list[str] = []
        last_error: CheckpointError | None = None
        for index, path in enumerate(versions):
            checkpoint_id = path.stem.split("-checkpoint-", 1)[-1]
            if checkpoint_id:
                checkpoint_id = f"checkpoint-{checkpoint_id}"
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                checkpoint = StructuredCheckpoint.from_dict(raw)
                self._verify_journal_position(checkpoint, events)
                return CheckpointLoadResult(
                    checkpoint=checkpoint,
                    fallback_used=index > 0,
                    warnings=tuple(warnings),
                )
            except (OSError, json.JSONDecodeError, CheckpointError) as exc:
                if isinstance(exc, CheckpointError):
                    last_error = exc
                else:
                    last_error = CheckpointIntegrityError(str(exc))
                warnings.append(f"{checkpoint_id or path.name}: {last_error}")
        assert last_error is not None
        raise last_error

    @staticmethod
    def _verify_journal_position(
        checkpoint: StructuredCheckpoint,
        events: tuple[Any, ...],
    ) -> None:
        last_sequence = events[-1].sequence if events else -1
        if checkpoint.event_sequence > last_sequence:
            raise CheckpointConsistencyError(
                f"checkpoint sequence {checkpoint.event_sequence} but journal ends at {last_sequence}"
            )
        event = events[checkpoint.event_sequence]
        if event.checksum != checkpoint.event_checksum:
            raise CheckpointConsistencyError(
                f"checkpoint sequence {checkpoint.event_sequence} checksum does not match journal"
            )

    def _prune(self) -> None:
        versions = list(self.list_versions())
        for path in versions[:-self.retention]:
            path.unlink(missing_ok=True)


__all__ = [
    "CHECKPOINT_SCHEMA_VERSION",
    "CheckpointConsistencyError",
    "CheckpointError",
    "CheckpointIntegrityError",
    "CheckpointLoadResult",
    "LegacyCheckpointView",
    "StructuredCheckpoint",
    "StructuredCheckpointStore",
    "migrate_legacy_checkpoint",
]
