"""Durable autonomous-goal queue shared by CLI, Bridge, and desktop clients.

The queue is deliberately separate from the model-facing agent loop.  It adds
product lifecycle controls without changing prompts, model parameters, or the
canonical reasoning implementation.
"""

from __future__ import annotations

import sqlite3
import threading
import uuid
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from arforge.database.sqlite_runtime import sqlite_connection

UTC = timezone.utc
MAX_OBJECTIVE_CHARS = 20_000
TERMINAL_STATUSES = {"completed", "cancelled"}
VISIBLE_STATUSES = {
    "queued",
    "active",
    "running",
    "paused",
    "blocked",
    "completed",
    "cancelled",
}


def workspace_goal_session_id(path: Path | str) -> str:
    """Return a stable, non-identifying queue key for one local workspace."""
    normalized = str(Path(path).resolve()).casefold().encode("utf-8")
    return f"workspace:{hashlib.sha256(normalized).hexdigest()[:24]}"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class GoalRuntimeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class GoalRuntime:
    """Persist and manage one active goal plus an ordered per-session queue."""

    def __init__(self, path: Path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        return sqlite_connection(self.path)

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS autonomous_goals (
                    goal_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    objective TEXT NOT NULL,
                    status TEXT NOT NULL,
                    queue_position INTEGER NOT NULL DEFAULT 0,
                    operation_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    last_error TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS ix_autonomous_goals_session
                    ON autonomous_goals(session_id, status, queue_position, created_at);
                CREATE UNIQUE INDEX IF NOT EXISTS ux_autonomous_goal_operation
                    ON autonomous_goals(operation_id)
                    WHERE operation_id IS NOT NULL;
                """
            )
            # A process restart cannot keep an in-memory operation alive.  Keep
            # the objective resumable and report the interruption honestly.
            now = _utc_now()
            connection.execute(
                """
                UPDATE autonomous_goals
                SET status='blocked', updated_at=?, finished_at=?,
                    last_error='execution interrupted before completion'
                WHERE status='running'
                """,
                (now, now),
            )

    @staticmethod
    def _objective(value: Any) -> str:
        if not isinstance(value, str) or not value.strip():
            raise GoalRuntimeError("INVALID_PARAMS", "objective must be a non-empty string")
        objective = value.strip()
        if len(objective) > MAX_OBJECTIVE_CHARS:
            raise GoalRuntimeError(
                "INVALID_PARAMS",
                f"objective exceeds {MAX_OBJECTIVE_CHARS} characters",
            )
        return objective

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def _active_row(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> sqlite3.Row | None:
        return connection.execute(
            """
            SELECT * FROM autonomous_goals
            WHERE session_id=? AND status IN ('active', 'running', 'paused', 'blocked')
            ORDER BY created_at ASC LIMIT 1
            """,
            (session_id,),
        ).fetchone()

    def _next_position(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> int:
        return int(
            connection.execute(
                """
                SELECT COALESCE(MAX(queue_position), 0) + 1
                FROM autonomous_goals
                WHERE session_id=? AND status='queued'
                """,
                (session_id,),
            ).fetchone()[0]
        )

    def _activate_next(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> dict[str, Any] | None:
        row = connection.execute(
            """
            SELECT * FROM autonomous_goals
            WHERE session_id=? AND status='queued'
            ORDER BY queue_position ASC, created_at ASC LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            return None
        now = _utc_now()
        connection.execute(
            """
            UPDATE autonomous_goals
            SET status='active', queue_position=0, updated_at=?,
                operation_id=NULL, last_error=''
            WHERE goal_id=?
            """,
            (now, row["goal_id"]),
        )
        return self._row(
            connection.execute(
                "SELECT * FROM autonomous_goals WHERE goal_id=?",
                (row["goal_id"],),
            ).fetchone()
        )

    def create(
        self,
        session_id: str,
        objective: str,
        *,
        queue: bool = False,
    ) -> dict[str, Any]:
        objective = self._objective(objective)
        if not isinstance(session_id, str) or not session_id.strip():
            raise GoalRuntimeError("INVALID_PARAMS", "session_id is required")
        now = _utc_now()
        with self._lock, self._connect() as connection:
            active = self._active_row(connection, session_id)
            status = "queued" if queue or active is not None else "active"
            position = self._next_position(connection, session_id) if status == "queued" else 0
            record = {
                "goal_id": str(uuid.uuid4()),
                "session_id": session_id,
                "objective": objective,
                "status": status,
                "queue_position": position,
                "operation_id": None,
                "created_at": now,
                "updated_at": now,
                "started_at": None,
                "finished_at": None,
                "last_error": "",
            }
            connection.execute(
                """
                INSERT INTO autonomous_goals(
                    goal_id, session_id, objective, status, queue_position,
                    operation_id, created_at, updated_at, started_at,
                    finished_at, last_error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                tuple(record.values()),
            )
        return record

    def list(self, session_id: str, *, include_history: bool = True) -> dict[str, Any]:
        statuses = VISIBLE_STATUSES if include_history else VISIBLE_STATUSES - TERMINAL_STATUSES
        placeholders = ",".join("?" for _ in statuses)
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM autonomous_goals
                WHERE session_id=? AND status IN ({placeholders})
                ORDER BY
                    CASE status
                        WHEN 'running' THEN 0 WHEN 'active' THEN 1
                        WHEN 'paused' THEN 2 WHEN 'blocked' THEN 3
                        WHEN 'queued' THEN 4 ELSE 5
                    END,
                    queue_position ASC, updated_at DESC
                """,
                (session_id, *sorted(statuses)),
            ).fetchall()
        items = [dict(row) for row in rows]
        return {
            "schema_version": 1,
            "session_id": session_id,
            "active": next(
                (
                    item
                    for item in items
                    if item["status"] in {"active", "running", "paused", "blocked"}
                ),
                None,
            ),
            "queued": [item for item in items if item["status"] == "queued"],
            "history": [
                item for item in items if item["status"] in TERMINAL_STATUSES
            ],
            "items": items,
            "count": len(items),
        }

    def get(self, session_id: str, goal_id: str) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM autonomous_goals
                WHERE goal_id=? AND session_id=?
                """,
                (goal_id, session_id),
            ).fetchone()
        if row is None:
            raise GoalRuntimeError("GOAL_NOT_FOUND", "goal not found")
        return dict(row)

    def bind_operation(
        self,
        session_id: str,
        goal_id: str,
        operation_id: str,
    ) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM autonomous_goals
                WHERE goal_id=? AND session_id=?
                """,
                (goal_id, session_id),
            ).fetchone()
            if row is None:
                raise GoalRuntimeError("GOAL_NOT_FOUND", "goal not found")
            if row["status"] not in {"active", "blocked"}:
                raise GoalRuntimeError(
                    "GOAL_NOT_RUNNABLE",
                    f"goal status {row['status']} cannot be started",
                )
            now = _utc_now()
            connection.execute(
                """
                UPDATE autonomous_goals
                SET status='running', operation_id=?, updated_at=?,
                    started_at=COALESCE(started_at, ?), finished_at=NULL,
                    last_error=''
                WHERE goal_id=?
                """,
                (operation_id, now, now, goal_id),
            )
            return dict(
                connection.execute(
                    "SELECT * FROM autonomous_goals WHERE goal_id=?",
                    (goal_id,),
                ).fetchone()
            )

    def pause(self, session_id: str, goal_id: str) -> dict[str, Any]:
        return self._set_nonterminal_status(
            session_id,
            goal_id,
            allowed={"active", "running", "blocked"},
            status="paused",
        )

    def resume(self, session_id: str, goal_id: str) -> dict[str, Any]:
        return self._set_nonterminal_status(
            session_id,
            goal_id,
            allowed={"paused", "blocked"},
            status="active",
            clear_operation=True,
        )

    def replace(self, session_id: str, goal_id: str, objective: str) -> dict[str, Any]:
        objective = self._objective(objective)
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM autonomous_goals WHERE goal_id=? AND session_id=?",
                (goal_id, session_id),
            ).fetchone()
            if row is None:
                raise GoalRuntimeError("GOAL_NOT_FOUND", "goal not found")
            if row["status"] == "running":
                raise GoalRuntimeError(
                    "GOAL_BUSY",
                    "pause or cancel the running goal before replacing it",
                )
            if row["status"] in TERMINAL_STATUSES:
                raise GoalRuntimeError("GOAL_FINISHED", "finished goals cannot be replaced")
            now = _utc_now()
            connection.execute(
                """
                UPDATE autonomous_goals
                SET objective=?, updated_at=?, last_error=''
                WHERE goal_id=?
                """,
                (objective, now, goal_id),
            )
            return dict(
                connection.execute(
                    "SELECT * FROM autonomous_goals WHERE goal_id=?",
                    (goal_id,),
                ).fetchone()
            )

    def cancel(self, session_id: str, goal_id: str) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM autonomous_goals WHERE goal_id=? AND session_id=?",
                (goal_id, session_id),
            ).fetchone()
            if row is None:
                raise GoalRuntimeError("GOAL_NOT_FOUND", "goal not found")
            if row["status"] in TERMINAL_STATUSES:
                return dict(row)
            now = _utc_now()
            connection.execute(
                """
                UPDATE autonomous_goals
                SET status='cancelled', updated_at=?, finished_at=?,
                    queue_position=0
                WHERE goal_id=?
                """,
                (now, now, goal_id),
            )
            if row["status"] != "queued":
                self._activate_next(connection, session_id)
            return dict(
                connection.execute(
                    "SELECT * FROM autonomous_goals WHERE goal_id=?",
                    (goal_id,),
                ).fetchone()
            )

    def delete_queued(self, session_id: str, goal_id: str) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM autonomous_goals WHERE goal_id=? AND session_id=?",
                (goal_id, session_id),
            ).fetchone()
            if row is None:
                raise GoalRuntimeError("GOAL_NOT_FOUND", "goal not found")
            if row["status"] != "queued":
                raise GoalRuntimeError("GOAL_NOT_QUEUED", "only queued goals can be deleted")
            connection.execute(
                "DELETE FROM autonomous_goals WHERE goal_id=?",
                (goal_id,),
            )
            self._normalize_queue(connection, session_id)
        return {"goal_id": goal_id, "deleted": True}

    def reorder(self, session_id: str, goal_ids: list[str]) -> dict[str, Any]:
        if not isinstance(goal_ids, list) or not all(
            isinstance(item, str) and item for item in goal_ids
        ):
            raise GoalRuntimeError("INVALID_PARAMS", "goal_ids must be a list of ids")
        if len(goal_ids) != len(set(goal_ids)):
            raise GoalRuntimeError("INVALID_PARAMS", "goal_ids must be unique")
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT goal_id FROM autonomous_goals
                WHERE session_id=? AND status='queued'
                ORDER BY queue_position ASC, created_at ASC
                """,
                (session_id,),
            ).fetchall()
            existing = [row["goal_id"] for row in rows]
            if set(goal_ids) != set(existing):
                raise GoalRuntimeError(
                    "INVALID_PARAMS",
                    "goal_ids must contain every queued goal exactly once",
                )
            now = _utc_now()
            connection.executemany(
                """
                UPDATE autonomous_goals
                SET queue_position=?, updated_at=?
                WHERE goal_id=? AND session_id=? AND status='queued'
                """,
                [
                    (index, now, goal_id, session_id)
                    for index, goal_id in enumerate(goal_ids, start=1)
                ],
            )
        return self.list(session_id, include_history=False)

    def operation_for_goal(self, session_id: str, goal_id: str) -> str | None:
        goal = self.get(session_id, goal_id)
        value = goal.get("operation_id")
        return value if isinstance(value, str) and value else None

    def observe_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type not in {
            "operation.completed",
            "operation.failed",
            "operation.cancelled",
            "operation.timed_out",
        }:
            return
        operation_id = event.get("operation_id")
        if not isinstance(operation_id, str) or not operation_id:
            return
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM autonomous_goals WHERE operation_id=?",
                (operation_id,),
            ).fetchone()
            if row is None:
                return
            if row["status"] == "paused":
                return
            if row["status"] == "cancelled":
                return
            if event_type == "operation.completed":
                status = "completed"
                error = ""
            elif event_type == "operation.cancelled":
                status = "cancelled"
                error = ""
            else:
                status = "blocked"
                data = event.get("data")
                error = (
                    str(data.get("message", ""))[:1000]
                    if isinstance(data, dict)
                    else ""
                ) or "goal execution did not complete"
            now = _utc_now()
            connection.execute(
                """
                UPDATE autonomous_goals
                SET status=?, updated_at=?, finished_at=?, last_error=?
                WHERE goal_id=?
                """,
                (status, now, now, error, row["goal_id"]),
            )
            if status in TERMINAL_STATUSES:
                self._activate_next(connection, row["session_id"])

    def _set_nonterminal_status(
        self,
        session_id: str,
        goal_id: str,
        *,
        allowed: set[str],
        status: str,
        clear_operation: bool = False,
    ) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM autonomous_goals WHERE goal_id=? AND session_id=?",
                (goal_id, session_id),
            ).fetchone()
            if row is None:
                raise GoalRuntimeError("GOAL_NOT_FOUND", "goal not found")
            if row["status"] not in allowed:
                raise GoalRuntimeError(
                    "GOAL_INVALID_STATE",
                    f"goal status {row['status']} cannot become {status}",
                )
            now = _utc_now()
            connection.execute(
                """
                UPDATE autonomous_goals
                SET status=?, updated_at=?, operation_id=CASE WHEN ? THEN NULL ELSE operation_id END,
                    finished_at=NULL, last_error=CASE WHEN ? THEN '' ELSE last_error END
                WHERE goal_id=?
                """,
                (status, now, int(clear_operation), int(clear_operation), goal_id),
            )
            return dict(
                connection.execute(
                    "SELECT * FROM autonomous_goals WHERE goal_id=?",
                    (goal_id,),
                ).fetchone()
            )

    @staticmethod
    def _normalize_queue(connection: sqlite3.Connection, session_id: str) -> None:
        rows = connection.execute(
            """
            SELECT goal_id FROM autonomous_goals
            WHERE session_id=? AND status='queued'
            ORDER BY queue_position ASC, created_at ASC
            """,
            (session_id,),
        ).fetchall()
        connection.executemany(
            "UPDATE autonomous_goals SET queue_position=? WHERE goal_id=?",
            [(index, row["goal_id"]) for index, row in enumerate(rows, start=1)],
        )
