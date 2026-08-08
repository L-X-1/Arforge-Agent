from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import sqlite3
from pathlib import Path
import threading
import time

import pytest
from sqlalchemy import text
from arforge.product.direct_dispatch import dispatch


def _sqlite_url(path: Path) -> str:
    return f"sqlite:///{path.as_posix()}"


def test_database_modes_are_explicit_and_fail_closed(monkeypatch, tmp_path):
    from arforge.database.config import get_database_url

    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    monkeypatch.setenv("ARFORGE_DATABASE_MODE", "local")
    monkeypatch.delenv("ARFORGE_DB_URL", raising=False)
    assert get_database_url() == _sqlite_url(tmp_path / "learning.db")

    monkeypatch.setenv(
        "ARFORGE_DB_URL",
        "postgresql://agent:secret@localhost/arforge",
    )
    with pytest.raises(RuntimeError, match="must use SQLite"):
        get_database_url()

    monkeypatch.setenv("ARFORGE_DATABASE_MODE", "server")
    monkeypatch.delenv("ARFORGE_DB_URL", raising=False)
    with pytest.raises(RuntimeError, match="is required"):
        get_database_url()

    monkeypatch.setenv("ARFORGE_DB_URL", _sqlite_url(tmp_path / "wrong.db"))
    with pytest.raises(RuntimeError, match="must use PostgreSQL"):
        get_database_url()


def test_product_config_reports_local_sqlite_as_durable(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    response = dispatch({"id": 1, "version": "1.2", "method": "config.get"})

    assert response["ok"] is False
    assert response["error"]["code"] == "METHOD_NOT_FOUND"



def test_configured_server_failure_never_creates_a_sqlite_fallback(
    monkeypatch,
    tmp_path,
):
    import arforge.database.migration as migration
    from arforge.database.engine import dispose_engines, get_engine

    dispose_engines()
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    monkeypatch.setenv("ARFORGE_DATABASE_MODE", "server")
    monkeypatch.setenv(
        "ARFORGE_DB_URL",
        "postgresql://agent:secret@db.invalid/arforge",
    )

    def unavailable(_database):
        raise RuntimeError("server database unavailable")

    monkeypatch.setattr(migration, "ensure_database_schema", unavailable)
    with pytest.raises(RuntimeError, match="server database unavailable"):
        get_engine()
    assert not (tmp_path / "learning.db").exists()
    dispose_engines()


def test_sqlalchemy_sqlite_policy_and_concurrent_writes(monkeypatch, tmp_path):
    from arforge.database.engine import dispose_engines, get_engine, get_session
    from arforge.database.migration import LATEST_REVISION, current_revision

    database = tmp_path / "learning.db"
    monkeypatch.setenv("ARFORGE_DATABASE_MODE", "local")
    monkeypatch.setenv("ARFORGE_DB_URL", _sqlite_url(database))
    monkeypatch.setenv(
        "ARFORGE_MULTIAGENT_DB_URL",
        _sqlite_url(tmp_path / "multiagent.db"),
    )
    dispose_engines()
    engine = get_engine()
    with engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA journal_mode").scalar_one() == "wal"
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
        assert connection.exec_driver_sql("PRAGMA busy_timeout").scalar_one() == 15_000
        assert connection.exec_driver_sql("PRAGMA synchronous").scalar_one() == 1
    assert current_revision("main") == LATEST_REVISION

    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE concurrency_probe "
                "(id INTEGER PRIMARY KEY AUTOINCREMENT, worker INTEGER NOT NULL)"
            )
        )

    def write(worker: int) -> None:
        for _ in range(25):
            with get_session() as session:
                session.execute(
                    text("INSERT INTO concurrency_probe(worker) VALUES (:worker)"),
                    {"worker": worker},
                )

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(write, range(8)))

    with engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM concurrency_probe")).scalar_one() == 200
    dispose_engines()


def test_engine_initialization_migrates_once_under_thread_contention(monkeypatch):
    import arforge.database.engine as database_engine

    monkeypatch.setenv("ARFORGE_DATABASE_MODE", "local")
    monkeypatch.setenv("ARFORGE_DB_URL", "sqlite:///:memory:")
    database_engine.dispose_engines()
    entered = 0
    entered_lock = threading.Lock()

    def prepare(_url, _database):
        nonlocal entered
        with entered_lock:
            entered += 1
        time.sleep(0.02)

    monkeypatch.setattr(database_engine, "_prepare_schema", prepare)
    with ThreadPoolExecutor(max_workers=8) as pool:
        engines = list(pool.map(lambda _index: database_engine.get_engine(), range(8)))

    assert entered == 1
    assert len({id(engine) for engine in engines}) == 1
    database_engine.dispose_engines()


def test_startup_refuses_a_partially_created_schema(monkeypatch, tmp_path):
    from arforge.database.engine import dispose_engines, get_engine

    database = tmp_path / "partial.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE memories(id INTEGER PRIMARY KEY)")
    monkeypatch.setenv("ARFORGE_DATABASE_MODE", "local")
    monkeypatch.setenv("ARFORGE_DB_URL", _sqlite_url(database))
    dispose_engines()
    with pytest.raises(RuntimeError, match="schema is incomplete"):
        get_engine()
    dispose_engines()


def test_local_stores_enable_foreign_keys_and_record_schema_versions(tmp_path):
    from arforge.product.feedback_runtime import FeedbackRuntime
    from arforge.product.state_store import BridgeStateStore
    from arforge.product.task_runtime import TaskStore

    state = BridgeStateStore(tmp_path / "state.db")
    state.save_session(
        {
            "session_id": "session-1",
            "status": "open",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "title": "release test",
        }
    )
    state.save_message("session-1", "user", "hello")
    with state._connect() as connection:
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        connection.execute(
            "DELETE FROM bridge_sessions WHERE session_id='session-1'"
        )
        assert connection.execute(
            "SELECT COUNT(*) FROM bridge_messages WHERE session_id='session-1'"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT version FROM arforge_local_schema "
            "WHERE component='bridge_state'"
        ).fetchone()[0] == 4

    tasks = TaskStore(tmp_path / "tasks.db")
    feedback = FeedbackRuntime(tmp_path / "feedback.db")
    with tasks._connect() as connection:
        assert connection.execute(
            "SELECT version FROM arforge_local_schema "
            "WHERE component='bridge_tasks'"
        ).fetchone()[0] == 1
    with feedback._connect() as connection:
        assert connection.execute(
            "SELECT version FROM arforge_local_schema "
            "WHERE component='feedback'"
        ).fetchone()[0] == 1


def test_local_store_refuses_a_future_schema(tmp_path):
    from arforge.database.sqlite_runtime import SCHEMA_TABLE
    from arforge.product.state_store import BridgeStateStore

    path = tmp_path / "future.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            f"""
            CREATE TABLE {SCHEMA_TABLE} (
                component TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            f"INSERT INTO {SCHEMA_TABLE} VALUES ('bridge_state', 999, 'now')"
        )
    with pytest.raises(RuntimeError, match="newer than supported"):
        BridgeStateStore(path)


def test_profile_writer_lock_enforces_one_sidecar(tmp_path):
    from arforge.database.sqlite_runtime import (
        ProfileLockError,
        ProfileWriterLock,
    )

    path = tmp_path / "state" / "sidecar.lock"
    first = ProfileWriterLock(path)
    second = ProfileWriterLock(path)
    first.acquire()
    try:
        with pytest.raises(ProfileLockError, match="already using this profile"):
            second.acquire()
    finally:
        first.release()
    second.acquire()
    second.release()


def test_sqlite_online_backup_verify_and_restore(tmp_path):
    from arforge.database.backup import create_backup, restore_backup, verify_backup

    source = tmp_path / "source.db"
    with sqlite3.connect(source) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE facts(value TEXT NOT NULL)")
        connection.execute("INSERT INTO facts VALUES ('preserved')")

    backup = create_backup(
        tmp_path / "snapshot.db",
        _sqlite_url(source),
        require_confirm=False,
    )
    assert backup.success, backup.error
    assert verify_backup(backup.path).success

    target = tmp_path / "restored.db"
    restored = restore_backup(
        backup.path,
        _sqlite_url(target),
        require_confirm=False,
    )
    assert restored.success, restored.error
    with sqlite3.connect(target) as connection:
        assert connection.execute("SELECT value FROM facts").fetchone()[0] == "preserved"


def test_profile_backup_covers_all_local_databases_and_restores(tmp_path):
    from arforge.database.backup import (
        create_profile_backup,
        restore_profile_backup,
        verify_profile_backup,
    )

    profile = tmp_path / "profile"
    databases = [
        profile / "learning.db",
        profile / "multiagent.db",
        profile / "state" / "bridge_state.db",
        profile / "state" / "bridge_tasks.db",
        profile / "state" / "feedback.db",
    ]
    for index, path in enumerate(databases):
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TABLE marker(value INTEGER NOT NULL)")
            connection.execute("INSERT INTO marker VALUES (?)", (index,))

    backup = create_profile_backup(
        tmp_path / "profile-backup.zip",
        profile,
        require_confirm=False,
    )
    assert backup.success, backup.error
    assert verify_profile_backup(backup.path).success

    restored_profile = tmp_path / "restored-profile"
    restored = restore_profile_backup(
        backup.path,
        restored_profile,
        require_confirm=False,
    )
    assert restored.success, restored.error
    for index, original in enumerate(databases):
        restored_path = restored_profile / original.relative_to(profile)
        with sqlite3.connect(restored_path) as connection:
            assert connection.execute("SELECT value FROM marker").fetchone()[0] == index


def test_profile_backup_refuses_an_active_sidecar(tmp_path):
    from arforge.database.backup import create_profile_backup
    from arforge.database.sqlite_runtime import ProfileWriterLock

    profile = tmp_path / "profile"
    profile.mkdir()
    with sqlite3.connect(profile / "learning.db") as connection:
        connection.execute("CREATE TABLE marker(value INTEGER)")
    lock = ProfileWriterLock(profile / "state" / "sidecar.lock")
    lock.acquire()
    try:
        result = create_profile_backup(
            tmp_path / "blocked.zip",
            profile,
            require_confirm=False,
        )
    finally:
        lock.release()
    assert not result.success
    assert "already using this profile" in result.error


def test_profile_backup_verification_rejects_truncation(tmp_path):
    from arforge.database.backup import create_profile_backup, verify_profile_backup

    profile = tmp_path / "profile"
    profile.mkdir()
    with sqlite3.connect(profile / "learning.db") as connection:
        connection.execute("CREATE TABLE marker(value INTEGER)")

    result = create_profile_backup(
        tmp_path / "profile.zip",
        profile,
        require_confirm=False,
    )
    archive = Path(result.path)
    archive.write_bytes(archive.read_bytes()[:-30])
    assert not verify_profile_backup(archive).success


def test_profile_restore_rolls_back_if_a_later_replacement_fails(
    monkeypatch,
    tmp_path,
):
    import arforge.database.backup as backup_module
    from arforge.database.backup import create_profile_backup, restore_profile_backup

    source = tmp_path / "source"
    target = tmp_path / "target"
    for profile, values in ((source, (10, 20)), (target, (1, 2))):
        for name, value in zip(("learning.db", "multiagent.db"), values, strict=True):
            profile.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(profile / name) as connection:
                connection.execute("CREATE TABLE marker(value INTEGER)")
                connection.execute("INSERT INTO marker VALUES (?)", (value,))

    archived = create_profile_backup(
        tmp_path / "rollback.zip",
        source,
        require_confirm=False,
    )
    real_replace = backup_module.os.replace
    replacements = 0

    def fail_second_staged_replace(source_path, target_path):
        nonlocal replacements
        source_value = Path(source_path)
        if "databases" in source_value.parts:
            replacements += 1
            if replacements == 2:
                raise OSError("simulated replacement failure")
        return real_replace(source_path, target_path)

    monkeypatch.setattr(backup_module.os, "replace", fail_second_staged_replace)
    restored = restore_profile_backup(
        archived.path,
        target,
        require_confirm=False,
    )
    assert not restored.success
    for name, expected in (("learning.db", 1), ("multiagent.db", 2)):
        with sqlite3.connect(target / name) as connection:
            assert connection.execute("SELECT value FROM marker").fetchone()[0] == expected
