"""Execution helpers for tasks and commands."""

from __future__ import annotations

from arforge.command_runner import run_cmd
from arforge.tools.task_tools import create_task


def execute_command(command: str) -> str:
    return run_cmd(command)


def create_tasks_from_plan(plan_text: str):
    tasks = []
    for line in plan_text.splitlines():
        title = line.strip("- 0123456789.[]")
        if title:
            tasks.append(create_task(title))
    return tasks
