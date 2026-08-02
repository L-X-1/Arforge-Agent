"""Small subprocess sandbox."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from arforge.permission import check_command_permission


@dataclass
class CommandRunResult:
    success: bool
    stdout: str
    stderr: str
    returncode: int


def run_command_no_shell(
    command: str | Sequence[str],
    *,
    timeout: int = 10,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    encoding: str = "utf-8",
) -> CommandRunResult:
    args = command if isinstance(command, Sequence) and not isinstance(command, str) else str(command).split()
    if not args:
        return CommandRunResult(False, "", "empty command", 2)
    permission = check_command_permission(" ".join(args))
    if not permission.allowed:
        return CommandRunResult(False, "", permission.reason, 126)
    completed = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding=encoding,
        errors="replace",
        capture_output=True,
        timeout=timeout,
    )
    return CommandRunResult(completed.returncode == 0, completed.stdout, completed.stderr, completed.returncode)
