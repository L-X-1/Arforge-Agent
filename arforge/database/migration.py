"""Database schema initialization and versioned Alembic migrations."""

from __future__ import annotations

from arforge.database.base import Base


LATEST_REVISION = "0004_cache_evidence"
MAIN_TABLES = {
    "memories",
    "learning_experiences",
    "learning_outcomes",
    "learning_patterns",
    "token_usage",
}
MULTIAGENT_TABLES = {"multiagent_tasks", "multiagent_conversations"}


def _selected_tables(database: str) -> set[str]:
    if database == "main":
        return MAIN_TABLES
    if database == "multiagent":
        return MULTIAGENT_TABLES
    raise ValueError("database must be 'main' or 'multiagent'")


def _alembic_config(database: str):
    """Build a package-relative Alembic configuration without exposing URLs."""
    from pathlib import Path

    from alembic.config import Config

    _selected_tables(database)
    config = Config()
    config.set_main_option(
        "script_location",
        str(Path(__file__).with_name("migrations")),
    )
    config.attributes["database_kind"] = database
    return config


def upgrade_database(
    database: str = "main",
    revision: str = "head",
    sql: bool = False,
) -> None:
    """Upgrade one database to a versioned revision."""
    from alembic import command

    command.upgrade(_alembic_config(database), revision, sql=sql)


def downgrade_database(
    database: str = "main",
    revision: str = "base",
    sql: bool = False,
) -> None:
    """Downgrade one database; callers enforce backup and confirmation policy."""
    from alembic import command

    command.downgrade(_alembic_config(database), revision, sql=sql)


def current_revision(database: str = "main") -> str | None:
    """Return the applied revision without printing connection credentials."""
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine

    from arforge.database.config import (
        get_database_url,
        get_multiagent_database_url,
    )

    _selected_tables(database)
    url = get_database_url() if database == "main" else get_multiagent_database_url()
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            return MigrationContext.configure(connection).get_current_revision()
    finally:
        engine.dispose()


def schema_compatibility(database: str = "main") -> dict:
    """Validate whether an existing schema matches the latest model metadata."""
    from sqlalchemy import create_engine, inspect

    from arforge.database.config import (
        get_database_url,
        get_multiagent_database_url,
    )
    import arforge.database.models  # noqa: F401

    selected = _selected_tables(database)
    url = get_database_url() if database == "main" else get_multiagent_database_url()
    engine = create_engine(url)
    try:
        inspector = inspect(engine)
        actual_tables = set(inspector.get_table_names())
        missing_tables = sorted(selected - actual_tables)
        missing_columns: dict[str, list[str]] = {}
        for table in selected & actual_tables:
            expected = {
                column.name for column in Base.metadata.tables[table].columns
            }
            actual = {
                column["name"] for column in inspector.get_columns(table)
            }
            if expected - actual:
                missing_columns[table] = sorted(expected - actual)
        return {
            "compatible": not missing_tables and not missing_columns,
            "missing_tables": missing_tables,
            "missing_columns": missing_columns,
        }
    finally:
        engine.dispose()


def stamp_database(database: str = "main", revision: str = "head") -> None:
    """Stamp a compatible pre-Alembic schema without applying DDL."""
    from alembic import command

    compatibility = schema_compatibility(database)
    if not compatibility["compatible"]:
        raise RuntimeError(
            f"schema is not compatible with baseline: {compatibility}"
        )
    command.stamp(_alembic_config(database), revision)


def ensure_database_schema(database: str = "main") -> str:
    """Bring a release database to the latest schema without using create_all.

    Empty databases are migrated from the Alembic baseline. Compatible databases
    created by older Arforge builds are stamped before upgrading. Partially
    compatible schemas fail closed so startup cannot hide missing data.
    """
    expected = _selected_tables(database)
    revision = current_revision(database)
    if revision is None:
        compatibility = schema_compatibility(database)
        missing_tables = set(compatibility["missing_tables"])
        if missing_tables == expected and not compatibility["missing_columns"]:
            upgrade_database(database)
        elif compatibility["compatible"]:
            stamp_database(database)
        else:
            raise RuntimeError(
                f"{database} database schema is incomplete; restore a backup or "
                f"run an explicit repair before startup: {compatibility}"
            )
    else:
        upgrade_database(database)
    applied = current_revision(database)
    if applied != LATEST_REVISION:
        raise RuntimeError(
            f"{database} database migration stopped at {applied or 'none'}; "
            f"expected {LATEST_REVISION}"
        )
    return applied


def init_db() -> None:
    """Initialize or migrate the main database."""
    from arforge.database.engine import get_engine

    get_engine()


def init_ma_db() -> None:
    """Initialize or migrate the multi-agent database."""
    from arforge.database.engine import get_ma_engine

    get_ma_engine()


def show_db_info() -> str:
    """Return credential-free database diagnostics for the CLI."""
    from arforge.database.config import (
        describe_database_url,
        get_database_mode,
        get_database_url,
        get_multiagent_database_url,
    )

    return "\n".join(
        [
            f"mode:       {get_database_mode()}",
            f"main:       {describe_database_url(get_database_url())}",
            f"multiagent: {describe_database_url(get_multiagent_database_url())}",
        ]
    )
