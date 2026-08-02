"""Capability persistence helpers."""

from __future__ import annotations

from arforge.capability.capability_registry import list_capabilities


def init_capability_db():
    return {"success": True, "capabilities": len(list_capabilities())}


def capability_db_status():
    return init_capability_db()
