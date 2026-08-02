"""Shared, release-safe SQLite connection policy for local Arforge stores."""

from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3
from typing import Iterator

from sqlalchemy import event
from sqlalchemy.engine import Engine


DEFAULT_BUSY_TIMEOUT_MS = 15_000
SCHEMA_TABLE = "arforge_local_schema"


def busy_timeout_ms() -> int:
    """Return a bounded SQLite busy timeout configured for desktop workloads."""
    raw = os.getenv("ARFORGE_SQLITE_BUSY_TIMEOUT_MS", str(DEFAULT_BUSY_TIMEOUT_MS))
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError("ARFORGE_SQLITE_BUSY_TIMEOUT_MS must be an integer") from exc
    if not 1_000 <= value <= 120_000:
        raise RuntimeError("ARFORGE_SQLITE_BUSY_TIMEOUT_MS must be between 1000 and 120000")
    return value


def configure_connection(
    connection: sqlite3.Connection,
    *,
    enable_wal: bool = True,
) -> None:
    """Apply the same integrity and contention policy to every SQLite handle."""
    timeout = busy_timeout_ms()
    connection.execute(f"PRAGMA busy_timeout={timeout}")
    connection.execute("PRAGMA foreign_keys=ON")
    if enable_wal:
        # In-memory databases report ``memory`` and safely ignore WAL.
        connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")


@contextmanager
def sqlite_connection(
    path: str | Path,
    *,
    read_only: bool = False,
    enable_wal: bool = True,
) -> Iterator[sqlite3.Connection]:
    """Open a configured SQLite connection and always close its Windows handle."""
    resolved = Path(path).expanduser().resolve()
    if read_only:
        connection = sqlite3.connect(
            f"{resolved.as_uri()}?mode=ro",
            uri=True,
            timeout=busy_timeout_ms() / 1000,
        )
    else:
        resolved.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            resolved,
            timeout=busy_timeout_ms() / 1000,
        )
    connection.row_factory = sqlite3.Row
    configure_connection(
        connection,
        enable_wal=enable_wal and not read_only,
    )
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def install_sqlalchemy_pragmas(engine: Engine) -> None:
    """Install the local SQLite policy on all pooled DB-API connections."""
    if engine.dialect.name != "sqlite":
        return

    @event.listens_for(engine, "connect")
    def _configure(dbapi_connection, _connection_record) -> None:
        configure_connection(dbapi_connection)


def ensure_component_schema(
    connection: sqlite3.Connection,
    component: str,
    version: int,
) -> None:
    """Record a component schema version and reject unsupported future schemas."""
    connection.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {SCHEMA_TABLE} (
            component TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    row = connection.execute(
        f"SELECT version FROM {SCHEMA_TABLE} WHERE component=?",
        (component,),
    ).fetchone()
    current = int(row[0]) if row is not None else 0
    if current > version:
        raise RuntimeError(
            f"{component} schema version {current} is newer than supported version {version}"
        )
    connection.execute(
        f"""
        INSERT INTO {SCHEMA_TABLE}(component, version, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(component) DO UPDATE SET
            version=excluded.version,
            updated_at=excluded.updated_at
        """,
        (component, version),
    )


class ProfileLockError(RuntimeError):
    """Raised when another Arforge Sidecar already owns the local profile."""


class ProfileWriterLock:
    """Cross-platform, non-blocking lock for the one-writer Sidecar contract."""

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self._stream = None

    def acquire(self) -> None:
        if self._stream is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stream = self.path.open("a+b")
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            stream.close()
            raise ProfileLockError(
                "another Arforge instance is already using this profile"
            ) from exc
        self._stream = stream

    def release(self) -> None:
        stream = self._stream
        if stream is None:
            return
        try:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        finally:
            stream.close()
            self._stream = None

    def __enter__(self) -> "ProfileWriterLock":
        self.acquire()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.release()
