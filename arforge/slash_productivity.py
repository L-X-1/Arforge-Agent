"""Productivity slash helpers."""

from __future__ import annotations

from arforge.tools.task_tools import create_task, show_tasks


def task_add(text: str) -> str:
    task = create_task(text)
    return f"created #{task['id']}"


def task_list(_: str = "") -> str:
    return show_tasks()
