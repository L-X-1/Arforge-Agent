"""Semantic index metadata."""

from __future__ import annotations

from arforge.semantic_memory import rebuild_semantic_index


def rebuild_semantic_index_metadata():
    index = rebuild_semantic_index(force=True)
    return {"success": True, "documents": len(index.documents)}


def semantic_index_metadata_status():
    return rebuild_semantic_index_metadata()


def list_semantic_index_items(limit: int = 100):
    index = rebuild_semantic_index(force=False)
    return list(index.documents.values())[:limit]


def list_semantic_items_by_type(source_type: str, limit: int = 100):
    return [item for item in list_semantic_index_items(limit) if item.get("mem_type") == source_type]


def show_semantic_item_text(source_type: str, source_id_text: str):
    source_id = int(source_id_text)
    return next((item for item in list_semantic_index_items(10000) if item.get("id") == source_id), None)
