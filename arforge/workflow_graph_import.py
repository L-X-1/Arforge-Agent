"""Verified one-way import of legacy Workflow Graph SQLite state.

The source is always opened read-only. PostgreSQL writes happen in one
transaction, existing run identifiers are compared rather than overwritten,
and every imported bundle is re-read and fingerprinted before commit.
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
from typing import Any, Protocol

from arforge.database.sqlite_runtime import sqlite_connection
from arforge.workflow_graph_store import (
    WorkflowGraphConnection,
    WorkflowGraphStore,
)

UTC = timezone.utc
ACTIVE_STATUSES = frozenset(
    {"running", "pause_requested", "cancellation_requested"}
)

RUN_COLUMNS = (
    "run_id",
    "session_id",
    "name",
    "description",
    "source_path",
    "workspace",
    "definition_json",
    "permission_mode",
    "status",
    "control",
    "max_parallel",
    "created_at",
    "updated_at",
    "started_at",
    "finished_at",
    "last_error",
    "lease_owner",
    "lease_expires_at",
)
NODE_COLUMNS = (
    "run_id",
    "node_id",
    "position",
    "title",
    "kind",
    "access",
    "status",
    "attempt",
    "max_attempts",
    "depends_on_json",
    "continue_on_error",
    "when_step",
    "when_statuses_json",
    "output",
    "error",
    "started_at",
    "finished_at",
)
EVENT_COLUMNS = (
    "run_id",
    "sequence",
    "event_type",
    "node_id",
    "data_json",
    "created_at",
)


class WorkflowGraphImportError(RuntimeError):
    """Safe import failure that never includes database credentials."""


class WorkflowGraphImportStore(Protocol):
    def require_schema(self) -> None: ...

    def connect(self) -> AbstractContextManager[WorkflowGraphConnection]: ...


@dataclass(frozen=True)
class WorkflowGraphBundle:
    run: dict[str, Any]
    nodes: tuple[dict[str, Any], ...]
    events: tuple[dict[str, Any], ...]

    @property
    def run_id(self) -> str:
        return str(self.run["run_id"])

    def fingerprint(self) -> str:
        payload = {
            "run": self.run,
            "nodes": self.nodes,
            "events": self.events,
        }
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return sha256(encoded).hexdigest()


@dataclass(frozen=True)
class WorkflowGraphImportReport:
    source: str
    target: str
    mode: str
    discovered_runs: int
    imported_runs: int
    already_present_runs: int
    forced_interruptions: int
    nodes: int
    events: int
    fingerprint_sha256: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "source": self.source,
            "target": self.target,
            "mode": self.mode,
            "discovered_runs": self.discovered_runs,
            "imported_runs": self.imported_runs,
            "already_present_runs": self.already_present_runs,
            "forced_interruptions": self.forced_interruptions,
            "nodes": self.nodes,
            "events": self.events,
            "fingerprint_sha256": self.fingerprint_sha256,
        }


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _canonical_json(
    value: Any,
    *,
    field: str,
    expected: type | tuple[type, ...] | None = None,
) -> str:
    try:
        decoded = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise WorkflowGraphImportError(f"legacy workflow field {field} is invalid JSON") from exc
    if expected is not None and not isinstance(decoded, expected):
        raise WorkflowGraphImportError(
            f"legacy workflow field {field} has an invalid JSON shape"
        )
    return json.dumps(decoded, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _table_columns(connection: Any, table: str) -> set[str]:
    return {
        str(row["name"])
        for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
    }


def _require_source_schema(connection: Any) -> dict[str, set[str]]:
    required = {
        "workflow_graph_runs",
        "workflow_graph_nodes",
        "workflow_graph_events",
    }
    tables = {
        str(row["name"])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    missing = sorted(required - tables)
    if missing:
        raise WorkflowGraphImportError(
            f"legacy workflow database is missing required tables: {', '.join(missing)}"
        )
    return {table: _table_columns(connection, table) for table in required}


def _required(mapping: dict[str, Any], key: str) -> Any:
    value = mapping.get(key)
    if value is None:
        raise WorkflowGraphImportError(f"legacy workflow field {key} is missing")
    return value


def _normalize_run(mapping: dict[str, Any]) -> dict[str, Any]:
    run = {
        "run_id": str(_required(mapping, "run_id")),
        "session_id": str(_required(mapping, "session_id")),
        "name": str(_required(mapping, "name")),
        "description": str(mapping.get("description") or ""),
        "source_path": str(mapping.get("source_path") or ""),
        "workspace": str(_required(mapping, "workspace")),
        "definition_json": _canonical_json(
            _required(mapping, "definition_json"),
            field="definition_json",
            expected=dict,
        ),
        "permission_mode": str(mapping.get("permission_mode") or "acceptEdits"),
        "status": str(_required(mapping, "status")),
        "control": str(mapping.get("control") or ""),
        "max_parallel": int(mapping.get("max_parallel") or 1),
        "created_at": str(_required(mapping, "created_at")),
        "updated_at": str(_required(mapping, "updated_at")),
        "started_at": mapping.get("started_at"),
        "finished_at": mapping.get("finished_at"),
        "last_error": str(mapping.get("last_error") or ""),
        # Lease ownership is process-local and is never portable.
        "lease_owner": "",
        "lease_expires_at": None,
    }
    return run


def _definition_positions(run: dict[str, Any]) -> dict[str, int]:
    definition = json.loads(run["definition_json"])
    steps = definition.get("steps", [])
    if not isinstance(steps, list):
        raise WorkflowGraphImportError(
            "legacy workflow definition_json steps must be a list"
        )
    positions: dict[str, int] = {}
    for position, item in enumerate(steps):
        if not isinstance(item, dict) or not item.get("id"):
            raise WorkflowGraphImportError(
                "legacy workflow definition contains an invalid step"
            )
        node_id = str(item["id"])
        if node_id in positions:
            raise WorkflowGraphImportError(
                f"legacy workflow definition contains duplicate node {node_id}"
            )
        positions[node_id] = position
    return positions


def _normalize_node(
    mapping: dict[str, Any],
    *,
    positions: dict[str, int],
) -> dict[str, Any]:
    node_id = str(_required(mapping, "node_id"))
    kind = str(mapping.get("kind") or "agent")
    access = str(mapping.get("access") or "")
    if not access:
        access = "none" if kind in {"approval", "checkpoint"} else "write"
    position = mapping.get("position")
    if position is None or (
        int(position) == 0 and positions.get(node_id, 0) != 0
    ):
        position = positions.get(node_id)
    if position is None:
        raise WorkflowGraphImportError(
            f"legacy workflow node {node_id} is absent from its definition"
        )
    return {
        "run_id": str(_required(mapping, "run_id")),
        "node_id": node_id,
        "position": int(position),
        "title": str(mapping.get("title") or node_id),
        "kind": kind,
        "access": access,
        "status": str(_required(mapping, "status")),
        "attempt": int(mapping.get("attempt") or 0),
        "max_attempts": int(mapping.get("max_attempts") or 1),
        "depends_on_json": _canonical_json(
            mapping.get("depends_on_json") or "[]",
            field="depends_on_json",
            expected=list,
        ),
        "continue_on_error": bool(mapping.get("continue_on_error")),
        "when_step": str(mapping.get("when_step") or ""),
        "when_statuses_json": _canonical_json(
            mapping.get("when_statuses_json") or "[]",
            field="when_statuses_json",
            expected=list,
        ),
        "output": str(mapping.get("output") or ""),
        "error": str(mapping.get("error") or ""),
        "started_at": mapping.get("started_at"),
        "finished_at": mapping.get("finished_at"),
    }


def _normalize_event(mapping: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_id": str(_required(mapping, "run_id")),
        "sequence": int(_required(mapping, "sequence")),
        "event_type": str(_required(mapping, "event_type")),
        "node_id": str(mapping.get("node_id") or ""),
        "data_json": _canonical_json(
            mapping.get("data_json") or "{}",
            field="data_json",
        ),
        "created_at": str(_required(mapping, "created_at")),
    }


def _force_interrupted(bundle: WorkflowGraphBundle) -> WorkflowGraphBundle:
    if bundle.run["status"] not in ACTIVE_STATUSES:
        return bundle
    now = _utc_now()
    run = {
        **bundle.run,
        "status": "interrupted",
        "control": "",
        "updated_at": now,
        "finished_at": None,
        "last_error": "workflow interrupted during verified SQLite import",
        "lease_owner": "",
        "lease_expires_at": None,
    }
    nodes = tuple(
        {
            **node,
            "status": "pending",
            "started_at": None,
            "finished_at": None,
            "error": "interrupted before migration completed",
        }
        if node["status"] == "running"
        else node
        for node in bundle.nodes
    )
    next_sequence = max((event["sequence"] for event in bundle.events), default=0) + 1
    event = {
        "run_id": bundle.run_id,
        "sequence": next_sequence,
        "event_type": "graph.interrupted",
        "node_id": "",
        "data_json": json.dumps(
            {"reason": "verified_sqlite_import"},
            sort_keys=True,
            separators=(",", ":"),
        ),
        "created_at": now,
    }
    return WorkflowGraphBundle(run=run, nodes=nodes, events=(*bundle.events, event))


def load_legacy_workflow_bundles(
    source: str | Path,
    *,
    force_interrupt: bool = False,
) -> tuple[WorkflowGraphBundle, ...]:
    """Load and normalize the legacy source without changing it."""
    path = Path(source).expanduser().resolve()
    if not path.is_file():
        raise WorkflowGraphImportError("legacy workflow database does not exist")
    bundles: list[WorkflowGraphBundle] = []
    with sqlite_connection(path, read_only=True) as connection:
        columns = _require_source_schema(connection)
        runs = connection.execute(
            "SELECT * FROM workflow_graph_runs ORDER BY created_at, run_id"
        ).fetchall()
        for raw_run in runs:
            run = _normalize_run(dict(raw_run))
            positions = _definition_positions(run)
            node_select = ", ".join(
                column
                for column in NODE_COLUMNS
                if column in columns["workflow_graph_nodes"]
            )
            raw_nodes = connection.execute(
                f"""
                SELECT {node_select} FROM workflow_graph_nodes
                WHERE run_id=? ORDER BY node_id
                """,
                (run["run_id"],),
            ).fetchall()
            nodes = tuple(
                sorted(
                    (
                        _normalize_node(dict(row), positions=positions)
                        for row in raw_nodes
                    ),
                    key=lambda item: (item["position"], item["node_id"]),
                )
            )
            raw_events = connection.execute(
                """
                SELECT run_id, sequence, event_type, node_id, data_json, created_at
                FROM workflow_graph_events WHERE run_id=? ORDER BY sequence
                """,
                (run["run_id"],),
            ).fetchall()
            events = tuple(_normalize_event(dict(row)) for row in raw_events)
            bundle = WorkflowGraphBundle(run=run, nodes=nodes, events=events)
            if run["status"] in ACTIVE_STATUSES and not force_interrupt:
                raise WorkflowGraphImportError(
                    "legacy workflow database contains active runs; stop their owner "
                    "or repeat with --force-interrupt"
                )
            bundles.append(
                _force_interrupted(bundle) if force_interrupt else bundle
            )
    return tuple(bundles)


def _fetch_target_bundle(
    connection: WorkflowGraphConnection,
    run_id: str,
) -> WorkflowGraphBundle | None:
    raw_run = connection.execute(
        "SELECT * FROM workflow_graph_runs WHERE run_id=?",
        (run_id,),
    ).fetchone()
    if raw_run is None:
        return None
    run = _normalize_run(dict(raw_run))
    positions = _definition_positions(run)
    nodes = tuple(
        _normalize_node(dict(row), positions=positions)
        for row in connection.execute(
            """
            SELECT * FROM workflow_graph_nodes
            WHERE run_id=? ORDER BY position, node_id
            """,
            (run_id,),
        ).fetchall()
    )
    events = tuple(
        _normalize_event(dict(row))
        for row in connection.execute(
            """
            SELECT run_id, sequence, event_type, node_id, data_json, created_at
            FROM workflow_graph_events WHERE run_id=? ORDER BY sequence
            """,
            (run_id,),
        ).fetchall()
    )
    return WorkflowGraphBundle(run=run, nodes=nodes, events=events)


def _insert_bundle(
    connection: WorkflowGraphConnection,
    bundle: WorkflowGraphBundle,
) -> None:
    run_placeholders = ", ".join("?" for _ in RUN_COLUMNS)
    connection.execute(
        f"""
        INSERT INTO workflow_graph_runs({", ".join(RUN_COLUMNS)})
        VALUES ({run_placeholders})
        ON CONFLICT (run_id) DO NOTHING
        """,
        tuple(bundle.run[column] for column in RUN_COLUMNS),
    )
    if bundle.nodes:
        node_placeholders = ", ".join("?" for _ in NODE_COLUMNS)
        connection.executemany(
            f"""
            INSERT INTO workflow_graph_nodes({", ".join(NODE_COLUMNS)})
            VALUES ({node_placeholders})
            ON CONFLICT (run_id, node_id) DO NOTHING
            """,
            [
                tuple(node[column] for column in NODE_COLUMNS)
                for node in bundle.nodes
            ],
        )
    if bundle.events:
        event_placeholders = ", ".join("?" for _ in EVENT_COLUMNS)
        connection.executemany(
            f"""
            INSERT INTO workflow_graph_events({", ".join(EVENT_COLUMNS)})
            VALUES ({event_placeholders})
            ON CONFLICT (run_id, sequence) DO NOTHING
            """,
            [
                tuple(event[column] for column in EVENT_COLUMNS)
                for event in bundle.events
            ],
        )


def _aggregate_fingerprint(bundles: tuple[WorkflowGraphBundle, ...]) -> str:
    joined = "\n".join(bundle.fingerprint() for bundle in bundles)
    return sha256(joined.encode("ascii")).hexdigest()


def import_workflow_graph_bundles(
    bundles: tuple[WorkflowGraphBundle, ...],
    *,
    store: WorkflowGraphImportStore,
    source: str | Path,
    target_description: str,
    apply: bool,
) -> WorkflowGraphImportReport:
    """Preflight collisions, optionally write, and verify all target bundles."""
    store.require_schema()
    already_present = 0
    missing: list[WorkflowGraphBundle] = []
    with store.connect() as connection:
        for bundle in bundles:
            target = _fetch_target_bundle(connection, bundle.run_id)
            if target is None:
                missing.append(bundle)
                continue
            if target.fingerprint() != bundle.fingerprint():
                raise WorkflowGraphImportError(
                    f"target already contains a different workflow run: {bundle.run_id}"
                )
            already_present += 1

        if apply:
            for bundle in missing:
                _insert_bundle(connection, bundle)
            for bundle in bundles:
                target = _fetch_target_bundle(connection, bundle.run_id)
                if target is None or target.fingerprint() != bundle.fingerprint():
                    raise WorkflowGraphImportError(
                        f"post-import verification failed for workflow run: {bundle.run_id}"
                    )

    forced = sum(
        1
        for bundle in bundles
        if bundle.run["last_error"]
        == "workflow interrupted during verified SQLite import"
    )
    return WorkflowGraphImportReport(
        source=str(Path(source).expanduser().resolve()),
        target=target_description,
        mode="apply" if apply else "dry-run",
        discovered_runs=len(bundles),
        imported_runs=len(missing) if apply else 0,
        already_present_runs=already_present,
        forced_interruptions=forced,
        nodes=sum(len(bundle.nodes) for bundle in bundles),
        events=sum(len(bundle.events) for bundle in bundles),
        fingerprint_sha256=_aggregate_fingerprint(bundles),
    )


def import_legacy_workflow_database(
    source: str | Path,
    *,
    database_url: str,
    target_description: str,
    apply: bool = False,
    force_interrupt: bool = False,
) -> WorkflowGraphImportReport:
    bundles = load_legacy_workflow_bundles(
        source,
        force_interrupt=force_interrupt,
    )
    store = WorkflowGraphStore(database_url=database_url)
    return import_workflow_graph_bundles(
        bundles,
        store=store,
        source=source,
        target_description=target_description,
        apply=apply,
    )
