"""Memory OS schema migration and model contracts."""

from __future__ import annotations

from sqlalchemy import create_engine, inspect, text


def test_fresh_main_migration_creates_governed_memory_schema(tmp_path, monkeypatch):
    from arforge.database.migration import current_revision, upgrade_database

    url = f"sqlite:///{tmp_path / 'memory-os.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", url)

    upgrade_database("main")

    inspector = inspect(create_engine(url))
    memory_columns = {column["name"] for column in inspector.get_columns("memories")}
    tables = set(inspector.get_table_names())
    assert {
        "memory_uid",
        "memory_class",
        "lifecycle",
        "confidence",
        "version",
        "content_digest",
        "provenance",
    } <= memory_columns
    assert {"memory_revisions", "memory_relations", "memory_retrieval_events"} <= tables
    assert current_revision("main") == "0005_memory_os"


def test_multiagent_migration_reaches_head_without_memory_tables(tmp_path, monkeypatch):
    from arforge.database.migration import current_revision, upgrade_database

    url = f"sqlite:///{tmp_path / 'multi.db'}"
    monkeypatch.setenv("ARFORGE_MULTIAGENT_DB_URL", url)

    upgrade_database("multiagent")

    tables = set(inspect(create_engine(url)).get_table_names())
    assert current_revision("multiagent") == "0005_memory_os"
    assert "memory_revisions" not in tables
    assert "memory_relations" not in tables
    assert "memory_retrieval_events" not in tables


def test_upgrade_from_0004_backfills_identity_digest_and_defaults(tmp_path, monkeypatch):
    from arforge.database.migration import upgrade_database

    url = f"sqlite:///{tmp_path / 'upgrade.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", url)
    upgrade_database("main", "0004_cache_evidence")
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO memories "
                "(created_at, updated_at, content, mem_type, tags, importance, source, "
                "related_to, strength, project_id, workspace_path, review_level, last_reviewed_at) "
                "VALUES ('2026-08-03', '2026-08-03', 'Prefer pytest', 'preference', '', 3, "
                "'user', '', 1.0, '', '', 0, '')"
            )
        )
    engine.dispose()

    upgrade_database("main")

    engine = create_engine(url)
    with engine.connect() as connection:
        learning_columns = {
            column["name"] for column in inspect(connection).get_columns("learning_patterns")
        }
        row = connection.execute(
            text(
                "SELECT memory_uid, memory_class, lifecycle, confidence, version, "
                "content_digest, provenance FROM memories WHERE id = 1"
            )
        ).mappings().one()
    engine.dispose()
    assert row["memory_uid"]
    assert row["memory_class"] == "user"
    assert row["lifecycle"] == "active"
    assert row["confidence"] == 1.0
    assert row["version"] == 1
    assert row["content_digest"].startswith("sha256:")
    assert row["provenance"] == "{}"
    assert "provenance" in learning_columns


def test_models_register_memory_os_tables_and_json_fields():
    from arforge.database import (
        Base,
        Memory,
        MemoryRelation,
        MemoryRetrievalEvent,
        MemoryRevision,
        LearningPattern,
    )

    assert Base.metadata.tables["memories"] is Memory.__table__
    assert Base.metadata.tables["memory_revisions"] is MemoryRevision.__table__
    assert Base.metadata.tables["memory_relations"] is MemoryRelation.__table__
    assert Base.metadata.tables["memory_retrieval_events"] is MemoryRetrievalEvent.__table__
    assert Memory.provenance.type.cache_ok is True
    assert MemoryRevision.snapshot.type.cache_ok is True
    assert MemoryRelation.evidence.type.cache_ok is True
    assert MemoryRetrievalEvent.returned.type.cache_ok is True
    assert LearningPattern.provenance.type.cache_ok is True
