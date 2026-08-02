"""Privacy-minimized durable metadata for Machine Bridge state."""

from __future__ import annotations

from contextlib import contextmanager
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from arforge.database.sqlite_runtime import (
    ensure_component_schema,
    sqlite_connection,
)

UTC = timezone.utc
BRIDGE_STATE_SCHEMA_VERSION = 4


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class BridgeStateStore:
    """Persist Bridge state and local, redacted conversation history."""

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
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS bridge_sessions (
                    session_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    project_id TEXT NOT NULL DEFAULT 'default',
                    parent_session_id TEXT,
                    title TEXT NOT NULL DEFAULT '新会话',
                    archived_at TEXT,
                    context_status_json TEXT NOT NULL DEFAULT '',
                    context_checkpoint_json TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS bridge_projects (
                    project_id TEXT PRIMARY KEY,
                    root TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS bridge_messages (
                    message_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                    content TEXT NOT NULL,
                    state TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    reasoning_json TEXT NOT NULL DEFAULT '',
                    tool_events_json TEXT NOT NULL DEFAULT '',
                    artifacts_json TEXT NOT NULL DEFAULT '',
                    delivery_json TEXT NOT NULL DEFAULT '',
                    rewound_at TEXT,
                    FOREIGN KEY(session_id) REFERENCES bridge_sessions(session_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS bridge_session_tags (
                    session_id TEXT NOT NULL,
                    tag TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(session_id, tag),
                    FOREIGN KEY(session_id) REFERENCES bridge_sessions(session_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS bridge_session_checkpoints (
                    checkpoint_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    label TEXT NOT NULL,
                    message_sequence INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    applied_at TEXT,
                    removed_messages INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY(session_id) REFERENCES bridge_sessions(session_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS bridge_approvals (
                    approval_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    action_type TEXT NOT NULL,
                    subject_id TEXT NOT NULL,
                    risk TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    decided_at TEXT,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS bridge_actions (
                    record_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    label TEXT NOT NULL,
                    risk TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    approval_id TEXT NOT NULL,
                    rollback_approval_id TEXT,
                    original_hash TEXT,
                    new_hash TEXT,
                    error TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_bridge_sessions_updated
                    ON bridge_sessions(updated_at DESC);
                CREATE UNIQUE INDEX IF NOT EXISTS ix_bridge_messages_sequence
                    ON bridge_messages(session_id, sequence);
                CREATE INDEX IF NOT EXISTS ix_bridge_actions_session
                    ON bridge_actions(session_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS ix_bridge_approvals_session
                    ON bridge_approvals(session_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS ix_bridge_session_tags_tag
                    ON bridge_session_tags(tag, session_id);
                CREATE INDEX IF NOT EXISTS ix_bridge_checkpoints_session
                    ON bridge_session_checkpoints(session_id, created_at DESC);
                """
            )
            session_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(bridge_sessions)")
            }
            if "project_id" not in session_columns:
                connection.execute(
                    "ALTER TABLE bridge_sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'"
                )
            if "parent_session_id" not in session_columns:
                connection.execute("ALTER TABLE bridge_sessions ADD COLUMN parent_session_id TEXT")
            if "title" not in session_columns:
                connection.execute(
                    "ALTER TABLE bridge_sessions ADD COLUMN title TEXT NOT NULL DEFAULT '新会话'"
                )
            if "archived_at" not in session_columns:
                connection.execute("ALTER TABLE bridge_sessions ADD COLUMN archived_at TEXT")
            if "context_status_json" not in session_columns:
                connection.execute(
                    "ALTER TABLE bridge_sessions ADD COLUMN "
                    "context_status_json TEXT NOT NULL DEFAULT ''"
                )
            if "context_checkpoint_json" not in session_columns:
                connection.execute(
                    "ALTER TABLE bridge_sessions ADD COLUMN "
                    "context_checkpoint_json TEXT NOT NULL DEFAULT ''"
                )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS ix_bridge_sessions_project ON bridge_sessions(project_id, updated_at DESC)"
            )
            # Idempotent column adds for existing databases that predate the
            # structured message columns (added alongside message_model.py).
            message_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(bridge_messages)")
            }
            for column in ("reasoning_json", "tool_events_json", "artifacts_json", "delivery_json"):
                if column not in message_columns:
                    connection.execute(
                        f"ALTER TABLE bridge_messages ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                    )
            if "rewound_at" not in message_columns:
                connection.execute("ALTER TABLE bridge_messages ADD COLUMN rewound_at TEXT")
            ensure_component_schema(
                connection,
                "bridge_state",
                BRIDGE_STATE_SCHEMA_VERSION,
            )
            now = _utc_now()
            connection.execute(
                "UPDATE bridge_sessions SET status='interrupted', updated_at=? WHERE status='active'",
                (now,),
            )
            connection.execute(
                """
                UPDATE bridge_approvals
                SET status='invalidated', decided_at=?, updated_at=?
                WHERE status IN ('pending', 'approved')
                """,
                (now, now),
            )
            connection.execute(
                """
                UPDATE bridge_actions
                SET status = CASE
                    WHEN status='applied' THEN 'applied_unrecoverable'
                    ELSE 'invalidated'
                END, updated_at=?,
                error='payload intentionally unavailable after process restart'
                WHERE status IN ('previewed', 'prepared', 'running', 'applied')
                """,
                (now,),
            )

    def save_session(self, record: dict[str, Any]) -> None:
        from arforge.security_guard import sanitize_for_storage

        context_status_json = json.dumps(
            sanitize_for_storage(record.get("context_status") or {}),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        context_checkpoint_json = json.dumps(
            sanitize_for_storage(record.get("context_checkpoint") or []),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO bridge_sessions(
                    session_id, status, created_at, updated_at, project_id,
                    parent_session_id, title, archived_at,
                    context_status_json, context_checkpoint_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    status=excluded.status, updated_at=excluded.updated_at,
                    project_id=excluded.project_id, parent_session_id=excluded.parent_session_id,
                    title=excluded.title, archived_at=excluded.archived_at,
                    context_status_json=excluded.context_status_json,
                    context_checkpoint_json=excluded.context_checkpoint_json
                """,
                (
                    record["session_id"],
                    record["status"],
                    record["created_at"],
                    record["updated_at"],
                    record.get("project_id", "default"),
                    record.get("parent_session_id"),
                    record.get("title", "新会话"),
                    record.get("archived_at"),
                    context_status_json,
                    context_checkpoint_json,
                ),
            )

    def set_sessions_archived(
        self,
        updates: list[tuple[str, str | None, str, str]],
    ) -> None:
        """Atomically persist archive/status changes for a validated session batch."""

        if not updates:
            return
        with self._lock, self._connect() as connection:
            cursor = connection.executemany(
                """
                UPDATE bridge_sessions
                SET status=?, archived_at=?, updated_at=?
                WHERE session_id=?
                """,
                updates,
            )
            if cursor.rowcount != len(updates):
                raise ValueError("one or more sessions disappeared during archive update")

    def import_session(
        self,
        record: dict[str, Any],
        messages: list[dict[str, str]],
        tags: list[str],
    ) -> None:
        """Atomically persist one validated portable transcript."""

        from arforge.security_guard import sanitize_for_storage

        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO bridge_sessions(
                    session_id, status, created_at, updated_at, project_id,
                    parent_session_id, title, archived_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["session_id"],
                    record["status"],
                    record["created_at"],
                    record["updated_at"],
                    record["project_id"],
                    record.get("parent_session_id"),
                    record["title"],
                    record.get("archived_at"),
                ),
            )
            now = _utc_now()
            connection.executemany(
                "INSERT INTO bridge_session_tags(session_id, tag, created_at) VALUES (?, ?, ?)",
                [(record["session_id"], tag, now) for tag in tags],
            )
            for sequence, item in enumerate(messages, start=1):
                connection.execute(
                    """
                    INSERT INTO bridge_messages(
                        message_id, session_id, role, content, state, sequence,
                        created_at, reasoning_json, tool_events_json,
                        artifacts_json, delivery_json, rewound_at
                    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, '', '', '', '', NULL)
                    """,
                    (
                        str(uuid.uuid4()),
                        record["session_id"],
                        item["role"],
                        str(sanitize_for_storage(item["content"]))[:100_000],
                        sequence,
                        item.get("created_at") or now,
                    ),
                )

    def load_sessions(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM bridge_sessions ORDER BY created_at ASC"
            ).fetchall()
            tag_rows = connection.execute(
                "SELECT session_id, tag FROM bridge_session_tags ORDER BY tag COLLATE NOCASE"
            ).fetchall()
        tags: dict[str, list[str]] = {}
        for row in tag_rows:
            tags.setdefault(row["session_id"], []).append(row["tag"])
        items: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            try:
                status = json.loads(item.get("context_status_json") or "{}")
            except (TypeError, json.JSONDecodeError):
                status = {}
            try:
                checkpoint = json.loads(
                    item.get("context_checkpoint_json") or "[]"
                )
            except (TypeError, json.JSONDecodeError):
                checkpoint = []
            item["context_status"] = status if isinstance(status, dict) else {}
            item["context_checkpoint"] = (
                checkpoint if isinstance(checkpoint, list) else []
            )
            item["tags"] = tags.get(row["session_id"], [])
            items.append(item)
        return items

    def set_session_tags(self, session_id: str, tags: list[str]) -> None:
        now = _utc_now()
        with self._lock, self._connect() as connection:
            exists = connection.execute(
                "SELECT 1 FROM bridge_sessions WHERE session_id=?",
                (session_id,),
            ).fetchone()
            if exists is None:
                raise ValueError("session not found")
            connection.execute(
                "DELETE FROM bridge_session_tags WHERE session_id=?",
                (session_id,),
            )
            connection.executemany(
                "INSERT INTO bridge_session_tags(session_id, tag, created_at) VALUES (?, ?, ?)",
                [(session_id, tag, now) for tag in tags],
            )
            connection.execute(
                "UPDATE bridge_sessions SET updated_at=? WHERE session_id=?",
                (now, session_id),
            )

    def ensure_project(self, root: str | Path) -> dict[str, Any]:
        resolved = Path(root).resolve()
        root_value = str(resolved)
        name = resolved.name or root_value
        now = _utc_now()
        with self._lock, self._connect() as connection:
            existing = connection.execute(
                "SELECT * FROM bridge_projects WHERE root=?", (root_value,)
            ).fetchone()
            if existing is not None:
                connection.execute(
                    "UPDATE bridge_projects SET name=?, updated_at=? WHERE project_id=?",
                    (name, now, existing["project_id"]),
                )
                return {**dict(existing), "name": name, "updated_at": now}
            project = {
                "project_id": str(uuid.uuid4()),
                "root": root_value,
                "name": name,
                "created_at": now,
                "updated_at": now,
            }
            connection.execute(
                "INSERT INTO bridge_projects(project_id, root, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                tuple(project.values()),
            )
            return project

    def list_projects(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT p.*, COUNT(s.session_id) AS session_count
                FROM bridge_projects p
                LEFT JOIN bridge_sessions s ON s.project_id=p.project_id
                GROUP BY p.project_id
                ORDER BY p.updated_at DESC
                """
            ).fetchall()
            items = [dict(row) for row in rows]
            stale_ids = []
            for item in items:
                root = Path(str(item.get("root", "")))
                if (
                    int(item.get("session_count", 0)) == 0
                    and ".arforge-worktrees" in root.parts
                    and not root.exists()
                ):
                    stale_ids.append(item["project_id"])
            if stale_ids:
                connection.executemany(
                    "DELETE FROM bridge_projects WHERE project_id=?",
                    [(project_id,) for project_id in stale_ids],
                )
                stale = set(stale_ids)
                items = [item for item in items if item["project_id"] not in stale]
        return items

    def save_message(
        self,
        session_id: str,
        role: str,
        content: str,
        *,
        state: str = "complete",
        reasoning: dict[str, str] | None = None,
        tool_events: list[dict[str, Any]] | None = None,
        artifacts: list[dict[str, Any]] | None = None,
        delivery: dict[str, Any] | None = None,
        max_messages: int = 500,
    ) -> dict[str, Any]:
        from arforge.security_guard import sanitize_for_storage

        if role not in {"user", "assistant"}:
            raise ValueError("message role must be user or assistant")
        safe_content = str(sanitize_for_storage(content))[:100_000]
        reasoning_json = json.dumps(reasoning or {}, ensure_ascii=False, separators=(",", ":")) if reasoning else ""
        tool_events_json = (
            json.dumps(tool_events or [], ensure_ascii=False, separators=(",", ":")) if tool_events else ""
        )
        artifacts_json = (
            json.dumps(artifacts or [], ensure_ascii=False, separators=(",", ":")) if artifacts else ""
        )
        delivery_json = (
            json.dumps(delivery or {}, ensure_ascii=False, separators=(",", ":")) if delivery else ""
        )
        now = _utc_now()
        with self._lock, self._connect() as connection:
            sequence = int(connection.execute(
                "SELECT COALESCE(MAX(sequence), 0) + 1 FROM bridge_messages WHERE session_id=?",
                (session_id,),
            ).fetchone()[0])
            record = {
                "message_id": str(uuid.uuid4()),
                "session_id": session_id,
                "role": role,
                "content": safe_content,
                "state": state,
                "sequence": sequence,
                "created_at": now,
            }
            connection.execute(
                """
                INSERT INTO bridge_messages(
                    message_id, session_id, role, content, state, sequence, created_at,
                    reasoning_json, tool_events_json, artifacts_json, delivery_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["message_id"],
                    session_id,
                    role,
                    safe_content,
                    state,
                    sequence,
                    now,
                    reasoning_json,
                    tool_events_json,
                    artifacts_json,
                    delivery_json,
                ),
            )
            connection.execute(
                """
                DELETE FROM bridge_messages WHERE message_id IN (
                    SELECT message_id FROM bridge_messages
                    WHERE session_id=? AND rewound_at IS NULL
                    ORDER BY sequence DESC LIMIT -1 OFFSET ?
                )
                """,
                (session_id, max_messages),
            )
            connection.execute(
                "UPDATE bridge_projects SET updated_at=? WHERE project_id=(SELECT project_id FROM bridge_sessions WHERE session_id=?)",
                (now, session_id),
            )
        return record

    def load_messages(self, session_id: str, limit: int = 500) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM (
                    SELECT * FROM bridge_messages
                    WHERE session_id=? AND rewound_at IS NULL
                    ORDER BY sequence DESC LIMIT ?
                ) ORDER BY sequence ASC
                """,
                (session_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def message_count(self, session_id: str) -> int:
        with self._lock, self._connect() as connection:
            return int(connection.execute(
                "SELECT COUNT(*) FROM bridge_messages WHERE session_id=? AND rewound_at IS NULL",
                (session_id,),
            ).fetchone()[0])

    def create_session_checkpoint(self, session_id: str, label: str) -> dict[str, Any]:
        now = _utc_now()
        with self._lock, self._connect() as connection:
            session = connection.execute(
                "SELECT 1 FROM bridge_sessions WHERE session_id=?",
                (session_id,),
            ).fetchone()
            if session is None:
                raise ValueError("session not found")
            sequence = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(sequence), 0)
                    FROM bridge_messages
                    WHERE session_id=? AND rewound_at IS NULL
                    """,
                    (session_id,),
                ).fetchone()[0]
            )
            record = {
                "checkpoint_id": str(uuid.uuid4()),
                "session_id": session_id,
                "label": label,
                "message_sequence": sequence,
                "created_at": now,
                "applied_at": None,
                "removed_messages": 0,
            }
            connection.execute(
                """
                INSERT INTO bridge_session_checkpoints(
                    checkpoint_id, session_id, label, message_sequence,
                    created_at, applied_at, removed_messages
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                tuple(record.values()),
            )
        return record

    def list_session_checkpoints(
        self,
        session_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM bridge_session_checkpoints
                WHERE session_id=?
                ORDER BY created_at DESC LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def preview_session_rewind(
        self,
        session_id: str,
        checkpoint_id: str,
    ) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            checkpoint = connection.execute(
                """
                SELECT * FROM bridge_session_checkpoints
                WHERE checkpoint_id=? AND session_id=?
                """,
                (checkpoint_id, session_id),
            ).fetchone()
            if checkpoint is None:
                raise ValueError("checkpoint not found")
            summary = connection.execute(
                """
                SELECT COUNT(*) AS message_count,
                       COALESCE(MAX(sequence), 0) AS last_sequence
                FROM bridge_messages
                WHERE session_id=? AND rewound_at IS NULL
                """,
                (session_id,),
            ).fetchone()
            removed = connection.execute(
                """
                SELECT COUNT(*) FROM bridge_messages
                WHERE session_id=? AND rewound_at IS NULL AND sequence>?
                """,
                (session_id, checkpoint["message_sequence"]),
            ).fetchone()[0]
        return {
            "checkpoint": dict(checkpoint),
            "current_message_count": int(summary["message_count"]),
            "expected_last_sequence": int(summary["last_sequence"]),
            "messages_to_rewind": int(removed),
        }

    def apply_session_rewind(
        self,
        session_id: str,
        checkpoint_id: str,
        expected_last_sequence: int,
    ) -> dict[str, Any]:
        now = _utc_now()
        with self._lock, self._connect() as connection:
            checkpoint = connection.execute(
                """
                SELECT * FROM bridge_session_checkpoints
                WHERE checkpoint_id=? AND session_id=?
                """,
                (checkpoint_id, session_id),
            ).fetchone()
            if checkpoint is None:
                raise ValueError("checkpoint not found")
            current_last = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(sequence), 0) FROM bridge_messages
                    WHERE session_id=? AND rewound_at IS NULL
                    """,
                    (session_id,),
                ).fetchone()[0]
            )
            if current_last != expected_last_sequence:
                raise RuntimeError("session history changed after rewind preview")
            cursor = connection.execute(
                """
                UPDATE bridge_messages SET rewound_at=?
                WHERE session_id=? AND rewound_at IS NULL AND sequence>?
                """,
                (now, session_id, checkpoint["message_sequence"]),
            )
            removed = int(cursor.rowcount)
            connection.execute(
                """
                UPDATE bridge_session_checkpoints
                SET applied_at=?, removed_messages=?
                WHERE checkpoint_id=?
                """,
                (now, removed, checkpoint_id),
            )
            connection.execute(
                "UPDATE bridge_sessions SET updated_at=? WHERE session_id=?",
                (now, session_id),
            )
            connection.execute(
                """
                DELETE FROM bridge_messages WHERE message_id IN (
                    SELECT message_id FROM bridge_messages
                    WHERE session_id=? AND rewound_at IS NOT NULL
                    ORDER BY sequence DESC LIMIT -1 OFFSET 500
                )
                """,
                (session_id,),
            )
        return {
            "checkpoint_id": checkpoint_id,
            "message_sequence": int(checkpoint["message_sequence"]),
            "removed_messages": removed,
            "applied_at": now,
        }

    def search_history(self, query: str, limit: int = 50) -> list[dict[str, Any]]:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT s.session_id, s.project_id, s.title, s.updated_at,
                       COALESCE(p.name, '历史对话') AS project_name,
                       COALESCE(p.root, '') AS project_root,
                       COALESCE((
                           SELECT substr(m.content, 1, 180) FROM bridge_messages m
                           WHERE m.session_id=s.session_id
                             AND m.rewound_at IS NULL
                             AND (m.content LIKE ? ESCAPE '\\'
                                  OR m.artifacts_json LIKE ? ESCAPE '\\')
                           ORDER BY m.sequence DESC LIMIT 1
                       ), '') AS snippet
                FROM bridge_sessions s
                LEFT JOIN bridge_projects p ON p.project_id=s.project_id
                WHERE s.title LIKE ? ESCAPE '\\'
                   OR p.name LIKE ? ESCAPE '\\'
                   OR EXISTS(SELECT 1 FROM bridge_messages m
                             WHERE m.session_id=s.session_id
                               AND m.rewound_at IS NULL
                               AND (m.content LIKE ? ESCAPE '\\'
                                    OR m.artifacts_json LIKE ? ESCAPE '\\'))
                ORDER BY s.updated_at DESC LIMIT ?
                """,
                # snippet: content match, then artifact path match
                (pattern, pattern, pattern, pattern, pattern, pattern, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def save_approval(self, record: dict[str, Any]) -> None:
        now = _utc_now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO bridge_approvals(
                    approval_id, session_id, action_type, subject_id, risk,
                    status, created_at, expires_at, decided_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(approval_id) DO UPDATE SET
                    status=excluded.status, decided_at=excluded.decided_at,
                    updated_at=excluded.updated_at
                """,
                (
                    record["approval_id"],
                    record["session_id"],
                    record["action_type"],
                    record["subject_id"],
                    record["risk"],
                    record["status"],
                    record["created_at"],
                    record["expires_at"],
                    record.get("decided_at"),
                    now,
                ),
            )

    def save_action(self, record: dict[str, Any]) -> None:
        now = _utc_now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO bridge_actions(
                    record_id, session_id, kind, status, label, risk,
                    created_at, updated_at, approval_id, rollback_approval_id,
                    original_hash, new_hash, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(record_id) DO UPDATE SET
                    status=excluded.status, updated_at=excluded.updated_at,
                    rollback_approval_id=excluded.rollback_approval_id,
                    error=excluded.error
                """,
                (
                    record["record_id"],
                    record["session_id"],
                    record["kind"],
                    record["status"],
                    record["label"],
                    record["risk"],
                    record["created_at"],
                    now,
                    record["approval_id"],
                    record.get("rollback_approval_id"),
                    record.get("original_hash"),
                    record.get("new_hash"),
                    record.get("error"),
                ),
            )

    def load_approvals(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM bridge_approvals ORDER BY created_at ASC"
            ).fetchall()
        return [self._public_approval(dict(row)) for row in rows]

    def load_actions(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM bridge_actions ORDER BY created_at ASC"
            ).fetchall()
        return [self._public_action(dict(row)) for row in rows]

    @staticmethod
    def _public_approval(row: dict[str, Any]) -> dict[str, Any]:
        row.pop("updated_at", None)
        row["summary"] = "Recovered approval metadata"
        row["recovered"] = True
        row["payload_available"] = False
        return row

    @staticmethod
    def _public_action(row: dict[str, Any]) -> dict[str, Any]:
        row["recovered"] = True
        row["payload_available"] = False
        return row
