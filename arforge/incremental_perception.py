"""Incremental project perception."""

from __future__ import annotations

from datetime import datetime

from arforge.analysis_index import build_analysis_index

_RUNS: list[dict] = []


def run_incremental_perception_quick():
    index = build_analysis_index()
    run = {"id": len(_RUNS) + 1, "mode": "quick", "created_at": datetime.now().isoformat(timespec="seconds"), "files": len(index)}
    _RUNS.append(run)
    return run


def run_incremental_perception_standard():
    return run_incremental_perception_quick() | {"mode": "standard"}


def run_incremental_perception_no_resolve():
    return run_incremental_perception_quick() | {"mode": "no_resolve"}


def list_incremental_perception_runs(limit: int = 20):
    return _RUNS[-limit:]
