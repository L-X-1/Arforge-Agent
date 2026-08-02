"""Alembic environment for Arforge's main and multi-agent databases."""

from __future__ import annotations

from alembic import context
from sqlalchemy import engine_from_config, pool

from arforge.database.base import Base
from arforge.database.config import get_database_url, get_multiagent_database_url
from arforge.database.sqlite_runtime import install_sqlalchemy_pragmas
import arforge.database.models  # noqa: F401


config = context.config
database_kind = config.attributes.get("database_kind", "main")
url = get_database_url() if database_kind == "main" else get_multiagent_database_url()
config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))

MAIN_TABLES = {"memories", "learning_experiences", "learning_outcomes", "learning_patterns", "token_usage"}
MULTIAGENT_TABLES = {"multiagent_tasks", "multiagent_conversations"}
selected_tables = MAIN_TABLES if database_kind == "main" else MULTIAGENT_TABLES


def include_object(obj, name, type_, reflected, compare_to):  # noqa: ARG001
    return type_ != "table" or name in selected_tables


def run_migrations_offline() -> None:
    context.configure(
        url=url,
        target_metadata=Base.metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    install_sqlalchemy_pragmas(connectable)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata, include_object=include_object)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
