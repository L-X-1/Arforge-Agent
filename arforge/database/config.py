"""Validated database URL selection for local and server deployments."""

from __future__ import annotations

import os
from pathlib import Path

import config as _runtime_config  # noqa: F401 - loads explicit supported .env paths


DATABASE_MODES = frozenset({"auto", "local", "server"})


def _get_arforge_home() -> Path:
    configured = os.getenv("ARFORGE_HOME", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".arforge").resolve()


def get_database_mode() -> str:
    """Return the validated deployment database mode."""
    mode = os.getenv("ARFORGE_DATABASE_MODE", "auto").strip().casefold()
    if mode not in DATABASE_MODES:
        choices = ", ".join(sorted(DATABASE_MODES))
        raise RuntimeError(f"ARFORGE_DATABASE_MODE must be one of: {choices}")
    return mode


def _driver_name(url: str) -> str:
    from sqlalchemy.engine import make_url

    return make_url(url).drivername.split("+", 1)[0]


def _validate_mode_url(mode: str, url: str, *, variable: str) -> None:
    from sqlalchemy.engine import make_url

    try:
        parsed = make_url(url)
        driver = parsed.drivername.split("+", 1)[0]
    except Exception as exc:
        raise RuntimeError(f"{variable} is invalid") from exc
    if driver == "postgresql" and (
        not parsed.host
        or not parsed.database
        or (parsed.host.startswith("[") and not parsed.host.endswith("]"))
    ):
        raise RuntimeError(f"{variable} is invalid")
    if driver == "sqlite" and not parsed.database:
        raise RuntimeError(f"{variable} must identify a SQLite database")
    if driver not in {"postgresql", "sqlite"}:
        raise RuntimeError(f"{variable} uses an unsupported database driver")
    if mode == "local" and driver != "sqlite":
        raise RuntimeError(f"{variable} must use SQLite when ARFORGE_DATABASE_MODE=local")
    if mode == "server" and driver != "postgresql":
        raise RuntimeError(
            f"{variable} must use PostgreSQL when ARFORGE_DATABASE_MODE=server"
        )


def _local_url(filename: str) -> str:
    directory = _get_arforge_home()
    directory.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{(directory / filename).as_posix()}"


def get_database_url() -> str:
    """Return the main database URL without silently changing backends."""
    mode = get_database_mode()
    configured = os.getenv("ARFORGE_DB_URL", "").strip()
    if configured:
        _validate_mode_url(mode, configured, variable="ARFORGE_DB_URL")
        return configured
    if mode == "server":
        raise RuntimeError(
            "ARFORGE_DB_URL is required when ARFORGE_DATABASE_MODE=server"
        )
    return _local_url("learning.db")


def get_multiagent_database_url() -> str:
    """Return an isolated multi-agent database URL for the selected mode."""
    from sqlalchemy.engine import make_url

    mode = get_database_mode()
    configured = os.getenv("ARFORGE_MULTIAGENT_DB_URL", "").strip()
    if configured:
        _validate_mode_url(
            mode,
            configured,
            variable="ARFORGE_MULTIAGENT_DB_URL",
        )
        return configured

    main_url = get_database_url()
    if _driver_name(main_url) == "sqlite":
        return _local_url("multiagent.db")

    main = make_url(main_url)
    if not main.database:
        raise RuntimeError("ARFORGE_DB_URL must include a database name")
    # Preserve the authority bytes exactly. Re-rendering a parsed SQLAlchemy URL
    # double-escapes percent-encoded password sequences (for example ``%2F``),
    # making the derived database silently use different credentials.
    database_separator = main_url.rfind("/")
    if database_separator < len("postgresql://"):
        raise RuntimeError("ARFORGE_DB_URL must include a database name")
    database_tail = main_url[database_separator + 1 :]
    _database, query_marker, query = database_tail.partition("?")
    derived = f"{main_url[:database_separator + 1]}{main.database}_ma"
    if query_marker:
        derived += f"?{query}"
    _validate_mode_url(mode, derived, variable="ARFORGE_MULTIAGENT_DB_URL")
    return derived


def describe_database_url(url: str | None = None) -> str:
    """Return a credential-free database target for user-facing output."""
    from sqlalchemy.engine import make_url

    parsed = make_url(url or get_database_url())
    driver = parsed.drivername.split("+", 1)[0]
    host = parsed.host or "local"
    port = f":{parsed.port}" if parsed.port else ""
    database = parsed.database or "unknown"
    return f"{driver}://{host}{port}/{database} (credentials hidden)"
