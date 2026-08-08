"""Append-only, integrity-checked event journal for one cognitive run."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping

from arforge.core.cognitive_ir import IRValidationError, canonical_json_bytes, utc_now


EVENT_SCHEMA_VERSION = "1.0"
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_EVENT_TYPE = re.compile(r"^[a-z][a-z0-9_.-]{1,127}$")
_CHECKSUM = re.compile(r"^sha256:[0-9a-f]{64}$")
_THREAD_LOCKS: dict[str, threading.RLock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


class JournalError(RuntimeError):
    """Base error for durable run journal operations."""


class JournalIntegrityError(JournalError):
    """Persisted bytes do not form one verified event chain."""


class JournalConflictError(JournalError):
    """Optimistic sequence did not match the durable journal."""


class JournalLockError(JournalError):
    """Another process owns the run's exclusive writer lock."""


class JournalPayloadTooLarge(JournalError):
    """A payload exceeds the configured data-minimization boundary."""


@dataclass(frozen=True)
class JournalPosition:
    sequence: int
    checksum: str


@dataclass(frozen=True)
class RunEvent:
    """One immutable event in a per-run hash chain."""

    event_id: str
    run_id: str
    sequence: int
    event_type: str
    timestamp: str
    actor: str
    payload: dict[str, Any]
    previous_checksum: str
    checksum: str
    schema_version: str = EVENT_SCHEMA_VERSION

    @classmethod
    def create(
        cls,
        *,
        run_id: str,
        sequence: int,
        event_type: str,
        payload: Mapping[str, Any],
        previous_checksum: str = "",
        actor: str = "runtime",
        timestamp: str | None = None,
        event_id: str | None = None,
    ) -> "RunEvent":
        unsigned = {
            "schema_version": EVENT_SCHEMA_VERSION,
            "event_id": event_id or f"evt-{uuid.uuid4().hex}",
            "run_id": run_id,
            "sequence": sequence,
            "event_type": event_type,
            "timestamp": timestamp or utc_now(),
            "actor": actor,
            "payload": dict(payload),
            "previous_checksum": previous_checksum,
        }
        checksum = _checksum(unsigned)
        event = cls(**unsigned, checksum=checksum)
        event.validate()
        return event

    @classmethod
    def from_dict(cls, data: Mapping[str, Any], *, sequence_hint: int) -> "RunEvent":
        if not isinstance(data, Mapping):
            raise JournalIntegrityError(f"sequence {sequence_hint}: event must be an object")
        required = {
            "schema_version",
            "event_id",
            "run_id",
            "sequence",
            "event_type",
            "timestamp",
            "actor",
            "payload",
            "previous_checksum",
            "checksum",
        }
        missing = sorted(required - set(data))
        if missing:
            raise JournalIntegrityError(f"sequence {sequence_hint}: missing fields {missing}")
        unknown = sorted(set(data) - required)
        if unknown:
            raise JournalIntegrityError(f"sequence {sequence_hint}: unknown fields {unknown}")
        try:
            event = cls(
                schema_version=str(data["schema_version"]),
                event_id=str(data["event_id"]),
                run_id=str(data["run_id"]),
                sequence=data["sequence"],
                event_type=str(data["event_type"]),
                timestamp=str(data["timestamp"]),
                actor=str(data["actor"]),
                payload=dict(data["payload"]),
                previous_checksum=str(data["previous_checksum"]),
                checksum=str(data["checksum"]),
            )
            event.validate()
        except (IRValidationError, TypeError, ValueError) as exc:
            raise JournalIntegrityError(f"sequence {sequence_hint}: invalid event shape: {exc}") from exc
        expected = _checksum(event.unsigned_dict())
        if event.checksum != expected:
            raise JournalIntegrityError(
                f"sequence {sequence_hint}: checksum mismatch; expected {expected}, got {event.checksum}"
            )
        return event

    def validate(self) -> None:
        if self.schema_version != EVENT_SCHEMA_VERSION:
            raise IRValidationError("schema_version", f"unsupported event schema {self.schema_version!r}")
        for name, value in (("event_id", self.event_id), ("run_id", self.run_id)):
            if not _IDENTIFIER.fullmatch(value):
                raise IRValidationError(name, "has an invalid identifier")
        if isinstance(self.sequence, bool) or not isinstance(self.sequence, int) or self.sequence < 0:
            raise IRValidationError("sequence", "must be a non-negative integer")
        if not _EVENT_TYPE.fullmatch(self.event_type):
            raise IRValidationError("event_type", "has an invalid event type")
        if not self.timestamp.strip():
            raise IRValidationError("timestamp", "must not be empty")
        if not self.actor.strip():
            raise IRValidationError("actor", "must not be empty")
        if not isinstance(self.payload, dict):
            raise IRValidationError("payload", "must be an object")
        canonical_json_bytes(self.payload)
        if self.previous_checksum and not _CHECKSUM.fullmatch(self.previous_checksum):
            raise IRValidationError("previous_checksum", "has an invalid checksum")
        if not _CHECKSUM.fullmatch(self.checksum):
            raise IRValidationError("checksum", "has an invalid checksum")

    def unsigned_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "event_id": self.event_id,
            "run_id": self.run_id,
            "sequence": self.sequence,
            "event_type": self.event_type,
            "timestamp": self.timestamp,
            "actor": self.actor,
            "payload": self.payload,
            "previous_checksum": self.previous_checksum,
        }

    def to_dict(self) -> dict[str, Any]:
        return {**self.unsigned_dict(), "checksum": self.checksum}


def _checksum(unsigned: Mapping[str, Any]) -> str:
    import hashlib

    return f"sha256:{hashlib.sha256(canonical_json_bytes(dict(unsigned))).hexdigest()}"


def _thread_lock(path: Path) -> threading.RLock:
    key = str(path.resolve())
    with _THREAD_LOCKS_GUARD:
        return _THREAD_LOCKS.setdefault(key, threading.RLock())


class RunEventJournal:
    """Single-writer JSONL backend for one local run.

    The adjacent lock file guards independent processes.  Expected sequence
    provides optimistic concurrency even if a stale writer retries later.
    """

    def __init__(
        self,
        path: str | Path,
        *,
        run_id: str,
        max_payload_bytes: int = 64 * 1024,
        lock_timeout: float = 2.0,
        stale_lock_seconds: float = 300.0,
    ) -> None:
        self.path = Path(path)
        self.run_id = run_id
        self.max_payload_bytes = max(1, int(max_payload_bytes))
        self.lock_timeout = max(0.0, float(lock_timeout))
        self.stale_lock_seconds = max(0.0, float(stale_lock_seconds))
        self.lock_path = Path(f"{self.path}.lock")
        if not _IDENTIFIER.fullmatch(run_id):
            raise ValueError("run_id has an invalid identifier")

    def read_verified(self) -> tuple[RunEvent, ...]:
        if not self.path.exists():
            return ()
        raw = self.path.read_bytes()
        if not raw:
            return ()
        lines = raw.splitlines(keepends=True)
        if not raw.endswith(b"\n"):
            sequence = max(0, len(lines) - 1)
            raise JournalIntegrityError(f"truncated final record at sequence {sequence}")

        events: list[RunEvent] = []
        previous = ""
        for index, line in enumerate(lines):
            if line in {b"\n", b"\r\n"}:
                raise JournalIntegrityError(f"sequence {index}: empty journal record")
            try:
                data = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise JournalIntegrityError(f"sequence {index}: invalid JSON: {exc}") from exc
            event = RunEvent.from_dict(data, sequence_hint=index)
            if event.sequence != index:
                raise JournalIntegrityError(
                    f"sequence {index}: discontinuity; event declares sequence {event.sequence}"
                )
            if event.run_id != self.run_id:
                raise JournalIntegrityError(
                    f"sequence {index}: run_id mismatch; expected {self.run_id!r}, got {event.run_id!r}"
                )
            if event.previous_checksum != previous:
                raise JournalIntegrityError(
                    f"sequence {index}: previous checksum mismatch; expected {previous!r}, "
                    f"got {event.previous_checksum!r}"
                )
            events.append(event)
            previous = event.checksum
        return tuple(events)

    def last_position(self) -> JournalPosition:
        events = self.read_verified()
        if not events:
            return JournalPosition(sequence=-1, checksum="")
        event = events[-1]
        return JournalPosition(sequence=event.sequence, checksum=event.checksum)

    def append(
        self,
        event_type: str,
        payload: Mapping[str, Any],
        *,
        actor: str = "runtime",
        expected_last_sequence: int | None = None,
        timestamp: str | None = None,
        event_id: str | None = None,
    ) -> RunEvent:
        try:
            payload_bytes = canonical_json_bytes(dict(payload))
        except (TypeError, ValueError) as exc:
            raise JournalError(f"payload is not valid canonical JSON: {exc}") from exc
        if len(payload_bytes) > self.max_payload_bytes:
            raise JournalPayloadTooLarge(
                f"payload is {len(payload_bytes)} bytes; limit is {self.max_payload_bytes}"
            )

        self.path.parent.mkdir(parents=True, exist_ok=True)
        with _thread_lock(self.path), self._exclusive_writer():
            events = self.read_verified()
            actual = events[-1].sequence if events else -1
            if expected_last_sequence is not None and expected_last_sequence != actual:
                raise JournalConflictError(
                    f"expected last sequence {expected_last_sequence}, actual {actual}"
                )
            previous = events[-1].checksum if events else ""
            event = RunEvent.create(
                run_id=self.run_id,
                sequence=actual + 1,
                event_type=event_type,
                payload=payload,
                previous_checksum=previous,
                actor=actor,
                timestamp=timestamp,
                event_id=event_id,
            )
            record = canonical_json_bytes(event.to_dict()) + b"\n"
            with self.path.open("ab", buffering=0) as stream:
                stream.write(record)
                os.fsync(stream.fileno())
            return event

    @contextmanager
    def _exclusive_writer(self) -> Iterator[None]:
        token = uuid.uuid4().hex
        deadline = time.monotonic() + self.lock_timeout
        while True:
            try:
                descriptor = os.open(
                    self.lock_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
            except FileExistsError:
                if self._remove_stale_lock():
                    continue
                if time.monotonic() >= deadline:
                    raise JournalLockError(
                        f"exclusive writer lock is held for run {self.run_id!r}: {self.lock_path}"
                    )
                time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))
                continue
            metadata = canonical_json_bytes(
                {"pid": os.getpid(), "token": token, "created_epoch": time.time()}
            )
            try:
                os.write(descriptor, metadata)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            break
        try:
            yield
        finally:
            try:
                current = json.loads(self.lock_path.read_text(encoding="utf-8"))
                if current.get("token") == token:
                    self.lock_path.unlink(missing_ok=True)
            except (OSError, json.JSONDecodeError):
                pass

    def _remove_stale_lock(self) -> bool:
        if self.stale_lock_seconds <= 0:
            return False
        try:
            metadata = json.loads(self.lock_path.read_text(encoding="utf-8"))
            if int(metadata.get("pid", -1)) == os.getpid():
                # The process-local RLock serializes legitimate writers. A
                # second lock file owned by this live process must not be
                # removed merely because a synthetic/old timestamp exists.
                return False
            created = float(metadata.get("created_epoch", 0.0))
            if time.time() - created <= self.stale_lock_seconds:
                return False
            self.lock_path.unlink()
            return True
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False


__all__ = [
    "EVENT_SCHEMA_VERSION",
    "JournalConflictError",
    "JournalError",
    "JournalIntegrityError",
    "JournalLockError",
    "JournalPayloadTooLarge",
    "JournalPosition",
    "RunEvent",
    "RunEventJournal",
]
