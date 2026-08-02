"""Perception orchestration."""

from __future__ import annotations

from arforge.incremental_perception_pipeline import refresh_perception_indexes


def prepare_perception_context(query: str):
    return {"query": query, "indexes": refresh_perception_indexes()}


def prepare_quick_perception_context(query: str):
    return prepare_perception_context(query)
