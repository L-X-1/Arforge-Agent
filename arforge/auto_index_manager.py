"""Auto index manager."""

from __future__ import annotations

from arforge.code_indexer import index_project
from arforge.python_ast_indexer import index_python_ast


def rebuild_code_indexes():
    return {"project": index_project(), "ast": index_python_ast()}


def update_code_indexes():
    return rebuild_code_indexes()


def clean_legacy_code_index():
    return {"success": True, "removed": 0}
