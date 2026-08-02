"""Database engine and transaction management for local and server modes."""

from __future__ import annotations

from contextlib import contextmanager, nullcontext
import threading
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from arforge.database.config import get_database_url, get_multiagent_database_url
from arforge.database.sqlite_runtime import (
    busy_timeout_ms,
    install_sqlalchemy_pragmas,
)


_engine: Engine | None = None
_SessionLocal: sessionmaker | None = None
_ma_engine: Engine | None = None
_MASessionLocal: sessionmaker | None = None

# SQLite has one writer at a time. Serialize ORM transactions in this process
# rather than making concurrent agent threads compete until "database is locked".
_main_sqlite_lock = threading.RLock()
_ma_sqlite_lock = threading.RLock()
_main_engine_init_lock = threading.Lock()
_ma_engine_init_lock = threading.Lock()


def _resolve_url() -> str:
    return get_database_url()


def _resolve_ma_url() -> str:
    return get_multiagent_database_url()


def _build_engine(url: str) -> Engine:
    """Build a SQLAlchemy engine with release-safe backend settings."""
    if url == "sqlite:///:memory:":
        from sqlalchemy import StaticPool

        engine = create_engine(
            url,
            echo=False,
            poolclass=StaticPool,
            connect_args={
                "check_same_thread": False,
                "timeout": busy_timeout_ms() / 1000,
            },
        )
    elif url.startswith("sqlite"):
        engine = create_engine(
            url,
            echo=False,
            pool_pre_ping=True,
            pool_size=5,
            pool_timeout=busy_timeout_ms() / 1000,
            connect_args={
                "check_same_thread": False,
                "timeout": busy_timeout_ms() / 1000,
            },
        )
    else:
        engine = create_engine(
            url,
            echo=False,
            pool_pre_ping=True,
            pool_size=5,
        )
    install_sqlalchemy_pragmas(engine)
    return engine


def _prepare_schema(url: str, database: str) -> None:
    if url == "sqlite:///:memory:":
        return
    from arforge.database.migration import ensure_database_schema

    ensure_database_schema(database)


def _create_memory_schema(engine: Engine, database: str) -> None:
    """Create disposable in-memory schemas that cannot be Alembic-reopened."""
    from arforge.database.base import Base
    import arforge.database.models  # noqa: F401

    if database == "multiagent":
        import arforge.database.models.multiagent  # noqa: F401

        Base.metadata.create_all(
            bind=engine,
            tables=[
                Base.metadata.tables["multiagent_tasks"],
                Base.metadata.tables["multiagent_conversations"],
            ],
        )
    else:
        Base.metadata.create_all(bind=engine)


def get_engine() -> Engine:
    """Return the main engine; configured server failures are never downgraded."""
    global _engine
    if _engine is None:
        with _main_engine_init_lock:
            if _engine is None:
                url = _resolve_url()
                _prepare_schema(url, "main")
                _engine = _build_engine(url)
                if url == "sqlite:///:memory:":
                    _create_memory_schema(_engine, "main")
    return _engine


def get_ma_engine() -> Engine:
    """Return the isolated multi-agent engine for the selected deployment mode."""
    global _ma_engine
    if _ma_engine is None:
        with _ma_engine_init_lock:
            if _ma_engine is None:
                url = _resolve_ma_url()
                _prepare_schema(url, "multiagent")
                _ma_engine = _build_engine(url)
                if url == "sqlite:///:memory:":
                    _create_memory_schema(_ma_engine, "multiagent")
    return _ma_engine


def get_session_maker() -> sessionmaker:
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), expire_on_commit=False)
    return _SessionLocal


def get_ma_session_maker() -> sessionmaker:
    global _MASessionLocal
    if _MASessionLocal is None:
        _MASessionLocal = sessionmaker(bind=get_ma_engine(), expire_on_commit=False)
    return _MASessionLocal


@contextmanager
def get_session() -> Generator[Session, None, None]:
    """Open one atomic main transaction and serialize it for local SQLite."""
    engine = get_engine()
    guard = _main_sqlite_lock if engine.dialect.name == "sqlite" else nullcontext()
    with guard:
        session: Session = get_session_maker()()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()


@contextmanager
def get_ma_session() -> Generator[Session, None, None]:
    """Open one atomic multi-agent transaction with local writer serialization."""
    engine = get_ma_engine()
    guard = _ma_sqlite_lock if engine.dialect.name == "sqlite" else nullcontext()
    with guard:
        session: Session = get_ma_session_maker()()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()


def dispose_engines() -> None:
    """Close all pooled connections so profiles and databases can be switched."""
    global _engine, _ma_engine, _SessionLocal, _MASessionLocal
    if _engine is not None:
        _engine.dispose()
        _engine = None
    if _ma_engine is not None:
        _ma_engine.dispose()
        _ma_engine = None
    _SessionLocal = None
    _MASessionLocal = None
