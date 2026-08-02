"""Session-local execution context for workspace-aware tools."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Iterator


_SESSION_ID: ContextVar[str] = ContextVar("arforge_execution_session_id", default="local")
_WORKSPACE_OVERRIDE: ContextVar[Path | None] = ContextVar(
    "arforge_workspace_override",
    default=None,
)


def current_session_id() -> str:
    return _SESSION_ID.get()


def current_workspace(default: str | Path) -> Path:
    override = _WORKSPACE_OVERRIDE.get()
    if override is not None:
        return override
    from arforge.worktree_runtime import get_worktree_manager

    active = get_worktree_manager().active_workspace(current_session_id())
    if active is not None:
        return active
    return Path(default).expanduser().resolve()


def set_workspace_override(path: str | Path | None) -> None:
    _WORKSPACE_OVERRIDE.set(
        Path(path).expanduser().resolve() if path is not None else None
    )


@contextmanager
def execution_scope(
    session_id: str,
    *,
    workspace: str | Path | None = None,
) -> Iterator[None]:
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("session_id must be a non-empty string")
    session_token = _SESSION_ID.set(session_id.strip())
    workspace_token = _WORKSPACE_OVERRIDE.set(
        Path(workspace).expanduser().resolve() if workspace is not None else None
    )
    try:
        # These two modules feed the agent's compacted context and verification
        # facts. Scope them with the session so one desktop operation cannot
        # inherit another session's pending compaction or changed-file list.
        from arforge.core.change_tracker import change_tracker_scope
        from arforge.core.compaction import compaction_scope
        from arforge.core.run_report import run_report_scope
        from arforge.core.run_transaction import run_transaction_scope

        with (
            compaction_scope(),
            change_tracker_scope(),
            run_report_scope(),
            run_transaction_scope(),
        ):
            yield
    finally:
        _WORKSPACE_OVERRIDE.reset(workspace_token)
        _SESSION_ID.reset(session_token)


__all__ = [
    "current_session_id",
    "current_workspace",
    "execution_scope",
    "set_workspace_override",
]
