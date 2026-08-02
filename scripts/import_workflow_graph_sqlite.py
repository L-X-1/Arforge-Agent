#!/usr/bin/env python
"""Safely import legacy Workflow Graph SQLite state into PostgreSQL."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from sqlalchemy.engine import make_url

from arforge.database.config import describe_database_url, get_database_url
from arforge.paths import data_path
from arforge.workflow_graph_import import (
    WorkflowGraphImportError,
    import_legacy_workflow_database,
)
from arforge.workflow_graph_store import WorkflowGraphStorageError


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Preflight and import legacy Workflow Graph SQLite records into the "
            "configured Arforge PostgreSQL database. Dry-run is the default."
        )
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(data_path("workflows", "graph-runs.sqlite3")),
        help="legacy SQLite file (default: current Arforge profile)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write only after collision preflight; otherwise perform a dry-run",
    )
    parser.add_argument(
        "--force-interrupt",
        action="store_true",
        help="convert active legacy runs to resumable interrupted runs",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        database_url = get_database_url()
        if make_url(database_url).drivername.split("+", 1)[0] != "postgresql":
            raise WorkflowGraphImportError(
                "ARFORGE_DB_URL must select PostgreSQL for this import"
            )
        report = import_legacy_workflow_database(
            args.source,
            database_url=database_url,
            target_description=describe_database_url(database_url),
            apply=args.apply,
            force_interrupt=args.force_interrupt,
        )
    except (
        OSError,
        RuntimeError,
        WorkflowGraphImportError,
        WorkflowGraphStorageError,
    ) as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "WORKFLOW_GRAPH_IMPORT_FAILED",
                        "message": str(exc),
                    },
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    print(
        json.dumps(
            {"ok": True, "report": report.to_dict()},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
