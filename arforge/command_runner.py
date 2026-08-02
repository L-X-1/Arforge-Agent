"""Command runner facade."""

from __future__ import annotations

from arforge.sandbox import run_command_no_shell


def run_cmd(command: str, timeout: int = 10) -> str:
    result = run_command_no_shell(command, timeout=timeout)
    return result.stdout if result.success else result.stderr


def check_cmd_permission(command: str) -> dict:
    from arforge.permission import check_command_permission

    result = check_command_permission(command)
    return result.__dict__
