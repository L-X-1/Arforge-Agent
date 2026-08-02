"""Variable type and instance-call resolver."""

from __future__ import annotations

from arforge.analysis_index import get_analysis_index


def index_type_instances():
    return {"success": True, "variables": len(list_variable_types(100000))}


def list_variable_types(limit: int = 100):
    rows = []
    for path, item in get_analysis_index().items():
        rows.extend(item.assignments)
    return rows[:limit]


def find_variable_type(variable_name: str):
    return [row for row in list_variable_types(100000) if row["name"] == variable_name]


def list_file_variable_types(file_path: str):
    return [row for row in list_variable_types(100000) if row["file"] == file_path]


def list_instance_calls(limit: int = 100):
    rows = []
    for item in get_analysis_index().values():
        rows.extend(item.calls)
    return rows[:limit]


def find_instance_calls(object_name: str):
    return [row for row in list_instance_calls(100000) if row["name"].startswith(object_name + ".")]
