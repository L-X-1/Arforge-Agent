"""Local, privacy-preserving product feedback runtime."""

from __future__ import annotations

from contextlib import contextmanager
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
from arforge.security_guard import sanitize_for_storage


UTC = timezone.utc
CATEGORIES = frozenset({"bug", "feature", "experience", "other"})
MAX_MESSAGE_CHARS = 2_000
MAX_SESSION_ID_CHARS = 128
FEEDBACK_SCHEMA_VERSION = 1


class FeedbackRuntimeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class FeedbackRuntime:
    """Persist explicit user feedback locally with bounded public queries."""

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
                CREATE TABLE IF NOT EXISTS feedback_entries (
                    feedback_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    category TEXT NOT NULL,
                    rating INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    session_id TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_feedback_created
                    ON feedback_entries(created_at DESC);
                """
            )
            ensure_component_schema(
                connection,
                "feedback",
                FEEDBACK_SCHEMA_VERSION,
            )

    def submit(
        self,
        *,
        category: Any,
        rating: Any,
        message: Any,
        session_id: Any = None,
    ) -> dict[str, Any]:
        normalized_category = self._validate_category(category)
        normalized_rating = self._validate_rating(rating)
        normalized_message = self._validate_message(message)
        normalized_session = self._validate_session_id(session_id)
        record = {
            "feedback_id": str(uuid.uuid4()),
            "created_at": _utc_now(),
            "category": normalized_category,
            "rating": normalized_rating,
            "message": normalized_message,
            "session_id": normalized_session,
        }
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO feedback_entries(
                    feedback_id, created_at, category, rating, message, session_id
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    record["feedback_id"],
                    record["created_at"],
                    record["category"],
                    record["rating"],
                    record["message"],
                    record["session_id"],
                ),
            )
        self._record_learning(
            category=normalized_category,
            rating=normalized_rating,
            message=normalized_message,
            session_id=normalized_session,
        )
        return {"schema_version": 1, "stored_locally": True, "feedback": record}

    @staticmethod
    def _record_learning(
        *,
        category: str,
        rating: int,
        message: str,
        session_id: str | None,
    ) -> None:
        """Feed explicit non-neutral feedback into the formal learning engine."""
        if rating == 3:
            return
        try:
            from arforge.learning_system import Outcome, get_learning_system

            positive = rating >= 4
            get_learning_system().record_outcome(
                Outcome(
                    session_id=session_id or "",
                    user_input=f"Explicit {category} feedback: {message}",
                    intent="product_feedback",
                    route="feedback",
                    success=positive,
                    error_type="" if positive else "explicit_feedback",
                    error_message="" if positive else message,
                    user_feedback="helpful" if positive else "unhelpful",
                    tags=["explicit-feedback", category, f"rating-{rating}"],
                    importance=abs(rating - 3) / 2,
                )
            )
        except Exception:
            # Feedback persistence is the primary contract; learning is best-effort.
            return

    def list(self, limit: Any = 50, category: Any = None) -> dict[str, Any]:
        normalized_limit = self._validate_limit(limit)
        normalized_category = None if category is None else self._validate_category(category)
        query = "SELECT * FROM feedback_entries"
        params: list[Any] = []
        if normalized_category is not None:
            query += " WHERE category=?"
            params.append(normalized_category)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(normalized_limit)
        with self._lock, self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
            total = int(
                connection.execute(
                    "SELECT COUNT(*) FROM feedback_entries"
                    + (" WHERE category=?" if normalized_category is not None else ""),
                    ([normalized_category] if normalized_category is not None else []),
                ).fetchone()[0]
            )
        items = [dict(row) for row in rows]
        return {
            "schema_version": 1,
            "stored_locally": True,
            "category": normalized_category,
            "items": items,
            "count": len(items),
            "total": total,
        }

    def summary(self) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            total = int(connection.execute("SELECT COUNT(*) FROM feedback_entries").fetchone()[0])
            average = connection.execute("SELECT AVG(rating) FROM feedback_entries").fetchone()[0]
            rows = connection.execute(
                "SELECT category, COUNT(*) AS count FROM feedback_entries GROUP BY category ORDER BY category"
            ).fetchall()
        return {
            "schema_version": 1,
            "stored_locally": True,
            "total": total,
            "average_rating": round(float(average), 2) if average is not None else None,
            "by_category": [{"category": row["category"], "count": row["count"]} for row in rows],
        }

    def delete(self, feedback_id: Any) -> dict[str, Any]:
        if not isinstance(feedback_id, str) or not feedback_id.strip() or len(feedback_id) > 128:
            raise FeedbackRuntimeError("INVALID_PARAMS", "feedback_id must be a non-empty string")
        normalized = feedback_id.strip()
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM feedback_entries WHERE feedback_id=?",
                (normalized,),
            )
        deleted = cursor.rowcount > 0
        return {
            "schema_version": 1,
            "feedback_id": normalized,
            "deleted": deleted,
            "status": "deleted" if deleted else "not_found",
        }

    @staticmethod
    def _validate_category(value: Any) -> str:
        if not isinstance(value, str) or value.strip().casefold() not in CATEGORIES:
            raise FeedbackRuntimeError(
                "INVALID_FEEDBACK_CATEGORY",
                f"category must be one of: {', '.join(sorted(CATEGORIES))}",
            )
        return value.strip().casefold()

    @staticmethod
    def _validate_rating(value: Any) -> int:
        if isinstance(value, bool):
            raise FeedbackRuntimeError("INVALID_FEEDBACK_RATING", "rating must be an integer between 1 and 5")
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            raise FeedbackRuntimeError(
                "INVALID_FEEDBACK_RATING",
                "rating must be an integer between 1 and 5",
            ) from None
        if not 1 <= parsed <= 5:
            raise FeedbackRuntimeError("INVALID_FEEDBACK_RATING", "rating must be an integer between 1 and 5")
        return parsed

    @staticmethod
    def _validate_message(value: Any) -> str:
        if not isinstance(value, str):
            raise FeedbackRuntimeError("INVALID_FEEDBACK_MESSAGE", "message must be a string")
        if any(ord(character) < 32 and character not in {"\t", "\r", "\n"} for character in value):
            raise FeedbackRuntimeError("INVALID_FEEDBACK_MESSAGE", "message must not contain control characters")
        cleaned = str(sanitize_for_storage(value)).strip()
        if not cleaned:
            raise FeedbackRuntimeError("INVALID_FEEDBACK_MESSAGE", "message must not be empty")
        if len(cleaned) > MAX_MESSAGE_CHARS:
            raise FeedbackRuntimeError(
                "INVALID_FEEDBACK_MESSAGE",
                f"message must be at most {MAX_MESSAGE_CHARS} characters",
            )
        return cleaned

    @staticmethod
    def _validate_session_id(value: Any) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise FeedbackRuntimeError("INVALID_PARAMS", "session_id must be a string or null")
        cleaned = value.strip()
        if not cleaned or len(cleaned) > MAX_SESSION_ID_CHARS:
            raise FeedbackRuntimeError("INVALID_PARAMS", "session_id is invalid")
        return cleaned

    @staticmethod
    def _validate_limit(value: Any) -> int:
        if isinstance(value, bool):
            raise FeedbackRuntimeError("INVALID_PARAMS", "limit must be an integer between 1 and 100")
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            raise FeedbackRuntimeError("INVALID_PARAMS", "limit must be an integer between 1 and 100") from None
        if not 1 <= parsed <= 100:
            raise FeedbackRuntimeError("INVALID_PARAMS", "limit must be an integer between 1 and 100")
        return parsed
