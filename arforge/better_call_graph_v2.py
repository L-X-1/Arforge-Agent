"""Resolved call graph v2 helpers."""

from __future__ import annotations

from arforge.call_graph import index_call_graph, list_call_graph, list_callees, list_callers


def build_resolved_call_graph_v2():
    return index_call_graph()


def list_resolved_call_graph_v2(limit: int = 100):
    return list_call_graph(limit)


def list_resolved_callers_v2(symbol_name: str, limit: int = 100):
    return list_callers(symbol_name, limit)


def list_resolved_callees_v2(caller_name: str, limit: int = 100):
    return list_callees(caller_name, limit)


def list_file_resolved_calls_v2(file_path: str):
    return [row for row in list_call_graph(100000) if row["file"] == file_path]


def list_v2_calls_by_category(category: str, limit: int = 100):
    return [row for row in list_call_graph(100000) if category in row["name"]][:limit]
