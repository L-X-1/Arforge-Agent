"""Permission checks for potentially risky operations."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator


_CONFIRMATION_HANDLER: ContextVar[
    Callable[[str, str], bool] | None
] = ContextVar("arforge_confirmation_handler", default=None)


@dataclass
class PermissionResult:
    allowed: bool
    risk: str = "low"
    reason: str = "ok"


DENY_COMMAND_PATTERNS = ["rm -rf", "format ", "del /s", "shutdown", "reg delete"]
PROTECTED_PATH_PARTS = {".git", ".venv", "Windows", "System32"}


def check_command_permission(command: str) -> PermissionResult:
    lowered = command.lower()
    for pattern in DENY_COMMAND_PATTERNS:
        if pattern in lowered:
            return PermissionResult(False, "critical", f"blocked pattern: {pattern}")
    return PermissionResult(True, "medium" if any(word in lowered for word in ["delete", "remove", "del "]) else "low")


def check_path_permission(path: str | Path, operation: str = "read") -> PermissionResult:
    resolved = Path(path).resolve()
    if any(part in PROTECTED_PATH_PARTS for part in resolved.parts):
        return PermissionResult(False, "high", "protected path")
    if operation in {"write", "delete"} and not resolved.parent.exists():
        return PermissionResult(False, "medium", "parent does not exist")
    return PermissionResult(True, "low")


def request_confirmation(risk: str, description: str) -> bool:
    """Ask the user before running a risky operation.

    Hard-blocks ``critical`` risk regardless of input.  For other risks, defers
    to :func:`arforge.security.file_ops.request_confirmation` so the actual
    behaviour (interactive prompt vs. auto-approve via env) lives in one place.
    """
    if risk == "critical":
        return False
    handler = _CONFIRMATION_HANDLER.get()
    if handler is not None:
        try:
            return bool(handler(risk, description))
        except Exception:
            # A failed host approval channel must never become implicit consent.
            return False
    from arforge.security.file_ops import request_confirmation as _confirm

    return _confirm(risk, description)


@contextmanager
def confirmation_scope(
    handler: Callable[[str, str], bool] | None,
) -> Iterator[None]:
    """Route confirmations for the current execution context to its host."""
    token = _CONFIRMATION_HANDLER.set(handler)
    try:
        yield
    finally:
        _CONFIRMATION_HANDLER.reset(token)
