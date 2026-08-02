"""Durable metadata and background execution for Machine Bridge tasks."""

from __future__ import annotations

from contextlib import contextmanager
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from arforge.database.sqlite_runtime import (
    ensure_component_schema,
    sqlite_connection,
)
from arforge.product.action_runtime import ActionRuntime, ActionRuntimeError
from arforge.security_guard import sanitize_log_message

UTC = timezone.utc


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled", "interrupted"}
ACTIVE_STATUSES = {"accepted", "running", "cancellation_requested"}
TASK_STORE_SCHEMA_VERSION = 1


class TaskRuntimeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class TaskRecord:
    task_id: str
    session_id: str
    kind: str
    subject_id: str
    status: str
    created_at: str
    updated_at: str
    started_at: str | None = None
    finished_at: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    result: dict[str, Any] | None = None
    recovered: bool = False
    side_effects_possible: bool = False
    cancel_requested: threading.Event = field(default_factory=threading.Event, repr=False)
    start_gate: threading.Event = field(default_factory=threading.Event, repr=False)
    finished: threading.Event = field(default_factory=threading.Event, repr=False)
    thread: threading.Thread | None = field(default=None, repr=False)
    sequence: int = 0

    def public(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "session_id": self.session_id,
            "kind": self.kind,
            "subject_id": self.subject_id,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": (
                {"code": self.error_code, "message": self.error_message}
                if self.error_code
                else None
            ),
            "result": self.result,
            "result_available": self.result is not None,
            "recovered": self.recovered,
            "side_effects_possible": self.side_effects_possible,
        }


class TaskStore:
    """SQLite metadata journal. Tool arguments and results are never persisted."""

    def __init__(self, path: Path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        with sqlite_connection(self.path) as connection:
            yield connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS bridge_tasks (
                    task_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    subject_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    side_effects_possible INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            ensure_component_schema(
                connection,
                "bridge_tasks",
                TASK_STORE_SCHEMA_VERSION,
            )
            now = _utc_now()
            connection.execute(
                """
                UPDATE bridge_tasks
                SET status = 'interrupted', updated_at = ?, finished_at = ?,
                    error_code = 'PROCESS_RESTARTED',
                    error_message = 'task was interrupted by a previous process exit',
                    side_effects_possible = CASE WHEN status IN ('running', 'cancellation_requested') THEN 1 ELSE 0 END
                WHERE status IN ('accepted', 'running', 'cancellation_requested')
                """,
                (now, now),
            )

    def save(self, record: TaskRecord) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO bridge_tasks (
                    task_id, session_id, kind, subject_id, status, created_at,
                    updated_at, started_at, finished_at, error_code,
                    error_message, side_effects_possible
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_id) DO UPDATE SET
                    status=excluded.status, updated_at=excluded.updated_at,
                    started_at=excluded.started_at, finished_at=excluded.finished_at,
                    error_code=excluded.error_code, error_message=excluded.error_message,
                    side_effects_possible=excluded.side_effects_possible
                """,
                (
                    record.task_id,
                    record.session_id,
                    record.kind,
                    record.subject_id,
                    record.status,
                    record.created_at,
                    record.updated_at,
                    record.started_at,
                    record.finished_at,
                    record.error_code,
                    record.error_message,
                    int(record.side_effects_possible),
                ),
            )

    def load(self) -> list[TaskRecord]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM bridge_tasks ORDER BY created_at ASC"
            ).fetchall()
        records: list[TaskRecord] = []
        for row in rows:
            record = TaskRecord(
                task_id=row["task_id"],
                session_id=row["session_id"],
                kind=row["kind"],
                subject_id=row["subject_id"],
                status=row["status"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                started_at=row["started_at"],
                finished_at=row["finished_at"],
                error_code=row["error_code"],
                error_message=row["error_message"],
                recovered=True,
                side_effects_possible=bool(row["side_effects_possible"]),
            )
            if record.status in TERMINAL_STATUSES:
                record.finished.set()
            records.append(record)
        return records

    def delete(self, task_ids: list[str]) -> None:
        if not task_ids:
            return
        placeholders = ",".join("?" for _ in task_ids)
        with self._lock, self._connect() as connection:
            connection.execute(
                f"DELETE FROM bridge_tasks WHERE task_id IN ({placeholders})",
                task_ids,
            )


class TaskRuntime:
    """Execute approved tool actions off the bridge request thread."""

    def __init__(
        self,
        actions: ActionRuntime,
        emit: Callable[[dict[str, Any]], None],
        store: TaskStore,
        *,
        max_concurrent: int = 8,
        max_history: int = 512,
    ):
        self._actions = actions
        self._emit_callback = emit
        self._store = store
        self._max_concurrent = max_concurrent
        self._max_history = max_history
        self._tasks = {record.task_id: record for record in store.load()}
        self._lock = threading.RLock()

    def submit_tool(self, session_id: str, action_id: str, approval_id: str) -> dict[str, Any]:
        with self._lock:
            self._prune_history()
            active = sum(record.status in ACTIVE_STATUSES for record in self._tasks.values())
            if active >= self._max_concurrent:
                raise TaskRuntimeError("TASK_LIMIT", "concurrent task limit reached")
            # Validate ownership and approval state before acknowledging work.
            action = self._actions.get_tool_action(session_id, action_id)
            approval = action.get("approval") or {}
            if approval.get("approval_id") != approval_id or approval.get("status") != "approved":
                raise TaskRuntimeError("APPROVAL_REQUIRED", "an approved matching approval is required")
            now = _utc_now()
            record = TaskRecord(
                task_id=str(uuid.uuid4()),
                session_id=session_id,
                kind="tool.execute",
                subject_id=action_id,
                status="accepted",
                created_at=now,
                updated_at=now,
            )
            record.thread = threading.Thread(
                target=self._run_tool,
                args=(record, approval_id),
                name=f"arforge-task-{record.task_id[:8]}",
                daemon=True,
            )
            self._tasks[record.task_id] = record
            self._store.save(record)
            record.thread.start()
            return record.public()

    def release_task(self, task_id: str) -> None:
        with self._lock:
            self._require_task(task_id).start_gate.set()

    def get_task(self, session_id: str, task_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_task(task_id)
            self._assert_session(session_id, record.session_id)
            return record.public()

    def list_tasks(self, session_id: str, limit: int = 50) -> dict[str, Any]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 200:
            raise TaskRuntimeError("INVALID_PARAMS", "limit must be an integer between 1 and 200")
        with self._lock:
            items = [item for item in self._tasks.values() if item.session_id == session_id]
            items.sort(key=lambda item: item.created_at, reverse=True)
            public = [item.public() for item in items[:limit]]
            return {"items": public, "count": len(public), "total": len(items)}

    def cancel_task(self, session_id: str, task_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_task(task_id)
            self._assert_session(session_id, record.session_id)
            if record.status in TERMINAL_STATUSES:
                return record.public()
            record.cancel_requested.set()
            record.status = "cancellation_requested"
            record.updated_at = _utc_now()
            if record.started_at is not None:
                record.side_effects_possible = True
            self._store.save(record)
            return record.public()

    def retry_task(self, session_id: str, task_id: str, ttl_seconds: int = 300) -> dict[str, Any]:
        with self._lock:
            record = self._require_task(task_id)
            self._assert_session(session_id, record.session_id)
            if record.status not in {"failed", "cancelled"}:
                raise TaskRuntimeError("INVALID_STATE", "only failed or cancelled tasks can be retried")
            if record.recovered:
                raise TaskRuntimeError(
                    "RETRY_PAYLOAD_UNAVAILABLE",
                    "task payload is intentionally not persisted; prepare the tool again",
                )
            try:
                return self._actions.retry_tool(session_id, record.subject_id, ttl_seconds)
            except ActionRuntimeError as exc:
                raise TaskRuntimeError(exc.code, exc.message) from None

    def has_active_tasks(self, session_id: str) -> bool:
        with self._lock:
            return any(
                record.session_id == session_id and record.status in ACTIVE_STATUSES
                for record in self._tasks.values()
            )

    def shutdown(self, join_timeout: float = 2.0) -> None:
        with self._lock:
            active = [record for record in self._tasks.values() if record.status in ACTIVE_STATUSES]
            for record in active:
                record.cancel_requested.set()
                record.start_gate.set()
        deadline = time.monotonic() + join_timeout
        for record in active:
            if record.thread and record.thread.is_alive():
                record.thread.join(max(0.0, deadline - time.monotonic()))

    def _run_tool(self, record: TaskRecord, approval_id: str) -> None:
        record.start_gate.wait()
        try:
            with self._lock:
                if record.cancel_requested.is_set():
                    self._finish_cancelled(record, side_effects_possible=False)
                    return
                now = _utc_now()
                record.status = "running"
                record.started_at = now
                record.updated_at = now
                self._store.save(record)
            self._emit(record, "task.started", {"kind": record.kind})
            from arforge.tools.basic_tools import command_cancellation_scope

            with command_cancellation_scope(record.cancel_requested):
                result = self._actions.execute_tool(record.session_id, record.subject_id, approval_id)
            with self._lock:
                if record.cancel_requested.is_set():
                    self._finish_cancelled(record, side_effects_possible=True)
                    return
                record.result = result
                action_succeeded = result.get("status") == "succeeded"
                record.status = "succeeded" if action_succeeded else "failed"
                if not action_succeeded:
                    tool_result = result.get("result") or {}
                    record.error_code = "TOOL_FAILED"
                    record.error_message = sanitize_log_message(
                        str(tool_result.get("error") or "tool execution failed")
                    )
                record.updated_at = _utc_now()
                record.finished_at = record.updated_at
                self._store.save(record)
            self._emit(
                record,
                "task.completed" if action_succeeded else "task.failed",
                (
                    {"kind": record.kind, "success": True}
                    if action_succeeded
                    else {"code": record.error_code, "message": record.error_message}
                ),
            )
        except ActionRuntimeError as exc:
            with self._lock:
                if record.cancel_requested.is_set():
                    self._finish_cancelled(
                        record,
                        side_effects_possible=record.started_at is not None,
                    )
                    return
                record.status = "failed"
                record.error_code = exc.code
                record.error_message = sanitize_log_message(exc.message)
                record.updated_at = _utc_now()
                record.finished_at = record.updated_at
                self._store.save(record)
            self._emit(
                record,
                "task.failed",
                {"code": record.error_code, "message": record.error_message},
            )
        except Exception as exc:
            with self._lock:
                if record.cancel_requested.is_set():
                    self._finish_cancelled(
                        record,
                        side_effects_possible=record.started_at is not None,
                    )
                    return
                record.status = "failed"
                record.error_code = "BACKEND_ERROR"
                record.error_message = sanitize_log_message(str(exc)) or "task execution failed"
                record.updated_at = _utc_now()
                record.finished_at = record.updated_at
                self._store.save(record)
            self._emit(
                record,
                "task.failed",
                {"code": record.error_code, "message": record.error_message},
            )
        finally:
            record.finished.set()

    def _finish_cancelled(self, record: TaskRecord, *, side_effects_possible: bool) -> None:
        record.status = "cancelled"
        record.side_effects_possible = side_effects_possible
        record.updated_at = _utc_now()
        record.finished_at = record.updated_at
        self._store.save(record)
        self._emit(
            record,
            "task.cancelled",
            {"reason": "client_request", "side_effects_possible": side_effects_possible},
        )

    def _emit(self, record: TaskRecord, event_type: str, data: dict[str, Any]) -> None:
        with self._lock:
            record.sequence += 1
            event = {
                "session_id": record.session_id,
                "task_id": record.task_id,
                "sequence": record.sequence,
                "timestamp": _utc_now(),
                "type": event_type,
                "data": data,
            }
        try:
            self._emit_callback(event)
        except Exception:
            # A bridge observer cannot be allowed to change a task result that
            # has already been durably committed. Event delivery is best effort.
            return

    def _require_task(self, task_id: str) -> TaskRecord:
        if not isinstance(task_id, str) or not task_id:
            raise TaskRuntimeError("INVALID_PARAMS", "task_id must be a non-empty string")
        record = self._tasks.get(task_id)
        if record is None:
            raise TaskRuntimeError("TASK_NOT_FOUND", "task not found")
        return record

    @staticmethod
    def _assert_session(requested: str, actual: str) -> None:
        if not isinstance(requested, str) or not requested:
            raise TaskRuntimeError("INVALID_PARAMS", "session_id must be a non-empty string")
        if requested != actual:
            raise TaskRuntimeError("SESSION_MISMATCH", "task belongs to another session")

    def _prune_history(self) -> None:
        if len(self._tasks) < self._max_history:
            return
        removable = [key for key, item in self._tasks.items() if item.status in TERMINAL_STATUSES]
        removed = removable[: len(self._tasks) - self._max_history + 1]
        for key in removed:
            self._tasks.pop(key, None)
        self._store.delete(removed)
