"""Versioned schema migration acceptance tests."""

from __future__ import annotations

from sqlalchemy import create_engine, inspect

from arforge.database.migration import (
    current_revision,
    downgrade_database,
    schema_compatibility,
    stamp_database,
    upgrade_database,
)

LATEST_REVISION = "0004_cache_evidence"


def test_main_and_multiagent_migrations_are_isolated(tmp_path, monkeypatch):
    main_url = f"sqlite:///{tmp_path / 'main.db'}"
    multi_url = f"sqlite:///{tmp_path / 'multi.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", main_url)
    monkeypatch.setenv("ARFORGE_MULTIAGENT_DB_URL", multi_url)

    upgrade_database("main")
    upgrade_database("multiagent")

    main_tables = set(inspect(create_engine(main_url)).get_table_names())
    multi_tables = set(inspect(create_engine(multi_url)).get_table_names())
    assert {"memories", "learning_experiences", "learning_outcomes", "learning_patterns", "token_usage"} <= main_tables
    assert "multiagent_tasks" not in main_tables
    assert {"multiagent_tasks", "multiagent_conversations"} <= multi_tables
    assert "memories" not in multi_tables
    assert current_revision("main") == LATEST_REVISION
    assert current_revision("multiagent") == LATEST_REVISION


def test_compatible_legacy_schema_can_be_stamped(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'legacy.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", url)
    from arforge.database.base import Base
    import arforge.database.models  # noqa: F401

    engine = create_engine(url)
    selected = [Base.metadata.tables[name] for name in ("memories", "learning_experiences", "learning_outcomes", "learning_patterns", "token_usage")]
    Base.metadata.create_all(engine, tables=selected)
    engine.dispose()

    assert schema_compatibility("main")["compatible"] is True
    stamp_database("main")
    assert current_revision("main") == LATEST_REVISION


def test_incomplete_schema_refuses_stamp(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'incomplete.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", url)
    create_engine(url).dispose()

    result = schema_compatibility("main")

    assert result["compatible"] is False


def test_baseline_downgrade_is_reversible_in_disposable_database(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'rollback.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", url)
    upgrade_database("main")

    downgrade_database("main", "base")

    tables = set(inspect(create_engine(url)).get_table_names())
    assert "memories" not in tables
    assert current_revision("main") is None


def test_cli_migration_fails_closed_without_confirmation(tmp_path, monkeypatch):
    from arforge.cli import main

    url = f"sqlite:///{tmp_path / 'denied.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", url)
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    assert main(["db-migrate", "main"]) == 1
    assert "alembic_version" not in inspect(create_engine(url)).get_table_names()


def test_cli_migration_allows_explicit_automation_approval(tmp_path, monkeypatch):
    from arforge.cli import main

    main_url = f"sqlite:///{tmp_path / 'approved-main.db'}"
    multi_url = f"sqlite:///{tmp_path / 'approved-multi.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", main_url)
    monkeypatch.setenv("ARFORGE_MULTIAGENT_DB_URL", multi_url)
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")

    assert main(["db-migrate", "all"]) == 0
    assert current_revision("main") == LATEST_REVISION
    assert current_revision("multiagent") == LATEST_REVISION
