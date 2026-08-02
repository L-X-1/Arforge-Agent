"""Perception pipeline."""

from __future__ import annotations

from arforge.code_indexer import index_project
from arforge.incremental_perception import run_incremental_perception_standard
from arforge.python_ast_indexer import index_python_ast


def refresh_perception_indexes():
    return {"project": index_project(), "ast": index_python_ast(), "perception": run_incremental_perception_standard()}


def refresh_perception_indexes_full():
    return refresh_perception_indexes()


def list_perception_runs(limit: int = 20):
    from arforge.incremental_perception import list_incremental_perception_runs

    return list_incremental_perception_runs(limit)


def show_perception_run(run_id_text: str):
    run_id = int(run_id_text)
    return next((item for item in list_perception_runs(1000) if item["id"] == run_id), None)
