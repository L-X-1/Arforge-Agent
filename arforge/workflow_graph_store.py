"""Database boundary for durable workflow graph state.

PostgreSQL is the canonical product backend when ``ARFORGE_DB_URL`` selects it.
SQLite remains available only for isolated tests and the frozen legacy Python
entry point. The store never falls back from a configured PostgreSQL URL.
"""

from __future__ import annotations

from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterator

from sqlalchemy.engine import make_url

from arforge.database.sqlite_runtime import sqlite_connection


class WorkflowGraphStorageError(RuntimeError):
    """Stable storage setup failure without credentials in its message."""


def _postgres_sql(statement: str) -> str:
    """Translate the runtime's DB-API qmark placeholders for psycopg2."""
    return statement.replace("?", "%s")


class WorkflowGraphConnection:
    """Small common DB-API surface used by the graph scheduler."""

    def __init__(self, connection: Any, *, dialect: str):
        self._connection = connection
        self.dialect = dialect

    @property
    def postgres(self) -> bool:
        return self.dialect == "postgresql"

    def execute(self, statement: str, parameters: Any = ()) -> Any:
        if not self.postgres:
            return self._connection.execute(statement, parameters)
        from psycopg2.extras import DictCursor

        cursor = self._connection.cursor(cursor_factory=DictCursor)
        cursor.execute(_postgres_sql(statement), parameters)
        return cursor

    def executemany(self, statement: str, parameters: Any) -> Any:
        if not self.postgres:
            return self._connection.executemany(statement, parameters)
        from psycopg2.extras import DictCursor

        cursor = self._connection.cursor(cursor_factory=DictCursor)
        cursor.executemany(_postgres_sql(statement), parameters)
        return cursor

    def executescript(self, script: str) -> Any:
        if self.postgres:
            raise WorkflowGraphStorageError(
                "PostgreSQL workflow schema must be installed by Core migrations"
            )
        return self._connection.executescript(script)


class WorkflowGraphStore:
    """Open transactional graph connections for exactly one configured backend."""

    def __init__(
        self,
        *,
        path: str | Path | None = None,
        database_url: str | None = None,
    ):
        if bool(path) == bool(database_url):
            raise ValueError("exactly one workflow graph database target is required")
        self.path = Path(path).expanduser().resolve() if path is not None else None
        self._database_url = database_url.strip() if database_url else None
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.dialect = "sqlite"
            self.identity = f"sqlite:{self.path}"
            return

        try:
            parsed = make_url(self._database_url or "")
        except Exception as exc:
            raise WorkflowGraphStorageError(
                "ARFORGE_DB_URL is invalid for workflow graph storage"
            ) from exc
        if parsed.drivername.split("+", 1)[0] != "postgresql":
            raise WorkflowGraphStorageError(
                "workflow graph database URL must use PostgreSQL"
            )
        if not parsed.host or not parsed.database or not parsed.username:
            raise WorkflowGraphStorageError(
                "workflow graph PostgreSQL URL is incomplete"
            )
        self.dialect = "postgresql"
        # Hash the complete URL for in-process cache identity without retaining
        # or displaying credentials in a path-like diagnostic value.
        self.identity = f"postgresql:{sha256((self._database_url or '').encode()).hexdigest()}"

    @property
    def postgres(self) -> bool:
        return self.dialect == "postgresql"

    @contextmanager
    def connect(self) -> Iterator[WorkflowGraphConnection]:
        if self.path is not None:
            with sqlite_connection(self.path) as connection:
                yield WorkflowGraphConnection(connection, dialect="sqlite")
            return

        try:
            from psycopg2 import connect
        except ImportError as exc:
            raise WorkflowGraphStorageError(
                "PostgreSQL workflow storage requires the Arforge postgres dependency"
            ) from exc

        parsed = make_url(self._database_url or "")
        try:
            connection = connect(
                host=parsed.host,
                port=parsed.port or 5432,
                dbname=parsed.database,
                user=parsed.username,
                password=parsed.password,
                connect_timeout=5,
                application_name="Arforge Workflow Graph",
            )
        except Exception as exc:
            raise WorkflowGraphStorageError(
                "unable to connect to the configured workflow graph PostgreSQL database"
            ) from exc
        try:
            with connection:
                yield WorkflowGraphConnection(connection, dialect="postgresql")
        finally:
            connection.close()

    def require_schema(self) -> None:
        if not self.postgres:
            return
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT
                    to_regclass('public.workflow_graph_runs') IS NOT NULL AS run_table,
                    to_regclass('public.workflow_graph_nodes') IS NOT NULL AS node_table,
                    to_regclass('public.workflow_graph_events') IS NOT NULL AS event_table
                """
            ).fetchone()
        if row is None or not all(
            bool(row[name]) for name in ("run_table", "node_table", "event_table")
        ):
            raise WorkflowGraphStorageError(
                "workflow graph PostgreSQL schema is missing; run Core database migrations with ARFORGE_DB_ADMIN_URL"
            )
