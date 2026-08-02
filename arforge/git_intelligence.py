"""Git repository intelligence."""

from __future__ import annotations

from arforge.sandbox import run_command_no_shell


def git_available() -> bool:
    return run_command_no_shell(["git", "--version"]).success


def git_status() -> str:
    result = run_command_no_shell(["git", "status", "--short"])
    return result.stdout if result.success else result.stderr


def is_git_repo() -> bool:
    return run_command_no_shell(["git", "rev-parse", "--is-inside-work-tree"]).success
