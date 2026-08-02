"""Durable FIFO prompt queue for busy interactive sessions."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from arforge.database.sqlite_runtime import sqlite_connection
from arforge.security_guard import sanitize_for_storage

UTC = timezone.utc
MAX_QUEUED_PROMPTS = 100


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class PromptQueueError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class PromptQueueRuntime:
    def __init__(self, path: Path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self):
        return sqlite_connection(self.path)

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS queued_prompts (
                    queue_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timeout_ms INTEGER NOT NULL,
                    reasoning_effort TEXT NOT NULL,
                    permission_mode TEXT,
                    context_json TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_queued_prompts_session
                    ON queued_prompts(session_id, position, created_at);
                """
            )

    def enqueue(
        self,
        session_id: str,
        content: str,
        *,
        timeout_ms: int,
        reasoning_effort: str,
        permission_mode: str | None,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        safe_content = str(sanitize_for_storage(content)).strip()
        now = _utc_now()
        with self._lock, self._connect() as connection:
            count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM queued_prompts WHERE session_id=?",
                    (session_id,),
                ).fetchone()[0]
            )
            if count >= MAX_QUEUED_PROMPTS:
                raise PromptQueueError(
                    "QUEUE_LIMIT",
                    f"a session can queue at most {MAX_QUEUED_PROMPTS} prompts",
                )
            position = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(position), 0) + 1
                    FROM queued_prompts WHERE session_id=?
                    """,
                    (session_id,),
                ).fetchone()[0]
            )
            record = {
                "queue_id": str(uuid.uuid4()),
                "session_id": session_id,
                "content": safe_content,
                "timeout_ms": timeout_ms,
                "reasoning_effort": reasoning_effort,
                "permission_mode": permission_mode,
                "context_json": json.dumps(
                    context,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                "position": position,
                "created_at": now,
            }
            connection.execute(
                """
                INSERT INTO queued_prompts(
                    queue_id, session_id, content, timeout_ms,
                    reasoning_effort, permission_mode, context_json,
                    position, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                tuple(record.values()),
            )
        return self._public(record)

    def list(self, session_id: str) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM queued_prompts
                WHERE session_id=?
                ORDER BY position ASC, created_at ASC
                """,
                (session_id,),
            ).fetchall()
        items = [self._public(dict(row)) for row in rows]
        return {"session_id": session_id, "items": items, "count": len(items)}

    def delete(self, session_id: str, queue_id: str) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM queued_prompts WHERE session_id=? AND queue_id=?",
                (session_id, queue_id),
            )
            if cursor.rowcount != 1:
                raise PromptQueueError("QUEUED_PROMPT_NOT_FOUND", "queued prompt not found")
            self._normalize(connection, session_id)
        return {"queue_id": queue_id, "deleted": True}

    def claim_next(self, session_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT * FROM queued_prompts
                WHERE session_id=?
                ORDER BY position ASC, created_at ASC LIMIT 1
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                "DELETE FROM queued_prompts WHERE queue_id=?",
                (row["queue_id"],),
            )
            self._normalize(connection, session_id)
            return self._public(dict(row))

    def peek_next(self, session_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM queued_prompts
                WHERE session_id=?
                ORDER BY position ASC, created_at ASC LIMIT 1
                """,
                (session_id,),
            ).fetchone()
        return self._public(dict(row)) if row is not None else None

    @staticmethod
    def _normalize(connection: sqlite3.Connection, session_id: str) -> None:
        rows = connection.execute(
            """
            SELECT queue_id FROM queued_prompts
            WHERE session_id=?
            ORDER BY position ASC, created_at ASC
            """,
            (session_id,),
        ).fetchall()
        connection.executemany(
            "UPDATE queued_prompts SET position=? WHERE queue_id=?",
            [(index, row["queue_id"]) for index, row in enumerate(rows, start=1)],
        )

    @staticmethod
    def _public(record: dict[str, Any]) -> dict[str, Any]:
        context: dict[str, Any] = {}
        raw_context = record.get("context_json")
        if isinstance(raw_context, str) and raw_context:
            try:
                parsed = json.loads(raw_context)
                if isinstance(parsed, dict):
                    context = parsed
            except json.JSONDecodeError:
                pass
        return {
            "queue_id": record["queue_id"],
            "session_id": record["session_id"],
            "content": record["content"],
            "timeout_ms": int(record["timeout_ms"]),
            "reasoning_effort": record["reasoning_effort"],
            "permission_mode": record.get("permission_mode"),
            "context": context,
            "position": int(record["position"]),
            "created_at": record["created_at"],
        }
