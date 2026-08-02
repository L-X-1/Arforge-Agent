"""Lossless migration checks for the legacy Workflow Graph SQLite store."""

from __future__ import annotations

import json
import sqlite3

import pytest


def _create_legacy_database(path):
    definition = {
        "schema_version": 2,
        "name": "legacy_graph",
        "description": "Legacy graph fixture",
        "steps": [
            {"id": "first", "title": "First", "prompt": "one"},
            {
                "id": "gate",
                "title": "Gate",
                "kind": "approval",
                "depends_on": ["first"],
            },
        ],
    }
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE workflow_graph_runs (
                run_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                source_path TEXT NOT NULL,
                workspace TEXT NOT NULL,
                definition_json TEXT NOT NULL,
                permission_mode TEXT NOT NULL,
                status TEXT NOT NULL,
                control TEXT NOT NULL DEFAULT '',
                max_parallel INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                last_error TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE workflow_graph_nodes (
                run_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                title TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                attempt INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 1,
                depends_on_json TEXT NOT NULL,
                continue_on_error INTEGER NOT NULL DEFAULT 0,
                when_step TEXT NOT NULL DEFAULT '',
                when_statuses_json TEXT NOT NULL DEFAULT '[]',
                output TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                started_at TEXT,
                finished_at TEXT,
                PRIMARY KEY(run_id, node_id)
            );
            CREATE TABLE workflow_graph_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                node_id TEXT NOT NULL DEFAULT '',
                data_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(run_id, sequence)
            );
            """
        )
        connection.execute(
            """
            INSERT INTO workflow_graph_runs(
                run_id, session_id, name, description, source_path, workspace,
                definition_json, permission_mode, status, control, max_parallel,
                created_at, updated_at, started_at, finished_at, last_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy-run",
                "session-1",
                "legacy_graph",
                "Legacy graph fixture",
                ".arforge/workflows/legacy.json",
                str(path.parent),
                json.dumps(definition),
                "acceptEdits",
                "running",
                "",
                2,
                "2026-07-27T00:00:00Z",
                "2026-07-27T00:01:00Z",
                "2026-07-27T00:01:00Z",
                None,
                "",
            ),
        )
        connection.executemany(
            """
            INSERT INTO workflow_graph_nodes(
                run_id, node_id, title, kind, status, attempt, max_attempts,
                depends_on_json, continue_on_error, when_step,
                when_statuses_json, output, error, started_at, finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "legacy-run",
                    "first",
                    "First",
                    "agent",
                    "running",
                    1,
                    1,
                    "[]",
                    0,
                    "",
                    "[]",
                    "",
                    "",
                    "2026-07-27T00:01:00Z",
                    None,
                ),
                (
                    "legacy-run",
                    "gate",
                    "Gate",
                    "approval",
                    "pending",
                    0,
                    1,
                    '["first"]',
                    0,
                    "",
                    "[]",
                    "",
                    "",
                    None,
                    None,
                ),
            ],
        )
        connection.execute(
            """
            INSERT INTO workflow_graph_events(
                run_id, sequence, event_type, node_id, data_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy-run",
                1,
                "graph.started",
                "",
                "{}",
                "2026-07-27T00:01:00Z",
            ),
        )


def _target_store(path):
    from arforge.workflow_graph_runtime import WorkflowGraphRuntime
    from arforge.workflow_graph_store import WorkflowGraphStore

    WorkflowGraphRuntime(path, lambda _step, _context: "unused")
    return WorkflowGraphStore(path=path)


def test_import_refuses_active_source_without_changing_it(tmp_path):
    from arforge.workflow_graph_import import (
        WorkflowGraphImportError,
        load_legacy_workflow_bundles,
    )

    source = tmp_path / "legacy.db"
    _create_legacy_database(source)

    with pytest.raises(WorkflowGraphImportError, match="active runs"):
        load_legacy_workflow_bundles(source)

    with sqlite3.connect(source) as connection:
        assert connection.execute(
            "SELECT status FROM workflow_graph_runs WHERE run_id='legacy-run'"
        ).fetchone()[0] == "running"


def test_forced_import_normalizes_legacy_rows_and_is_idempotent(tmp_path):
    from arforge.workflow_graph_import import (
        import_workflow_graph_bundles,
        load_legacy_workflow_bundles,
    )

    source = tmp_path / "legacy.db"
    target = tmp_path / "target.db"
    _create_legacy_database(source)
    bundles = load_legacy_workflow_bundles(source, force_interrupt=True)

    assert len(bundles) == 1
    bundle = bundles[0]
    assert bundle.run["status"] == "interrupted"
    assert bundle.run["lease_owner"] == ""
    assert [node["position"] for node in bundle.nodes] == [0, 1]
    assert [node["access"] for node in bundle.nodes] == ["write", "none"]
    assert [node["status"] for node in bundle.nodes] == ["pending", "pending"]
    assert bundle.events[-1]["event_type"] == "graph.interrupted"

    store = _target_store(target)
    first = import_workflow_graph_bundles(
        bundles,
        store=store,
        source=source,
        target_description="sqlite test target",
        apply=True,
    )
    assert first.imported_runs == 1
    assert first.already_present_runs == 0
    assert first.forced_interruptions == 1

    second = import_workflow_graph_bundles(
        bundles,
        store=store,
        source=source,
        target_description="sqlite test target",
        apply=True,
    )
    assert second.imported_runs == 0
    assert second.already_present_runs == 1
    assert second.fingerprint_sha256 == first.fingerprint_sha256


def test_import_rolls_back_when_target_run_id_has_different_content(tmp_path):
    from arforge.workflow_graph_import import (
        WorkflowGraphImportError,
        import_workflow_graph_bundles,
        load_legacy_workflow_bundles,
    )

    source = tmp_path / "legacy.db"
    target = tmp_path / "target.db"
    _create_legacy_database(source)
    bundles = load_legacy_workflow_bundles(source, force_interrupt=True)
    store = _target_store(target)
    import_workflow_graph_bundles(
        bundles,
        store=store,
        source=source,
        target_description="sqlite test target",
        apply=True,
    )
    with sqlite3.connect(target) as connection:
        connection.execute(
            "UPDATE workflow_graph_runs SET name='different' WHERE run_id='legacy-run'"
        )

    with pytest.raises(WorkflowGraphImportError, match="different workflow run"):
        import_workflow_graph_bundles(
            bundles,
            store=store,
            source=source,
            target_description="sqlite test target",
            apply=True,
        )


def test_dry_run_does_not_write_missing_runs(tmp_path):
    from arforge.workflow_graph_import import (
        import_workflow_graph_bundles,
        load_legacy_workflow_bundles,
    )

    source = tmp_path / "legacy.db"
    target = tmp_path / "target.db"
    _create_legacy_database(source)
    bundles = load_legacy_workflow_bundles(source, force_interrupt=True)
    store = _target_store(target)

    report = import_workflow_graph_bundles(
        bundles,
        store=store,
        source=source,
        target_description="sqlite test target",
        apply=False,
    )

    assert report.mode == "dry-run"
    assert report.imported_runs == 0
    with sqlite3.connect(target) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM workflow_graph_runs"
        ).fetchone()[0] == 0
