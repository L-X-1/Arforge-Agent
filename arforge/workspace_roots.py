"""Explicitly trusted additional workspace roots for local project work."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from arforge.paths import data_path
from arforge.trust_screen import is_workspace_trusted


class WorkspaceRootError(ValueError):
    """Raised when an additional workspace root violates the trust contract."""


def _state_path() -> Path:
    return Path(data_path("workspace_roots.json"))


def _load_state() -> list[str]:
    try:
        payload: Any = json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    roots = payload.get("roots", []) if isinstance(payload, dict) else []
    return [item for item in roots if isinstance(item, str)]


def _save_state(roots: list[Path]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"schema_version": 1, "roots": [str(root) for root in roots]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def configured_workspace_roots() -> list[Path]:
    """Return existing, individually trusted additional roots in stable order."""
    roots: list[Path] = []
    for raw_path in _load_state():
        try:
            root = Path(raw_path).expanduser().resolve()
        except OSError:
            continue
        if root.is_dir() and is_workspace_trusted(root) and root not in roots:
            roots.append(root)
    return roots


def authorized_workspace_roots(primary: str | Path) -> list[Path]:
    """Return the primary root followed by independently trusted extra roots."""
    primary_root = Path(primary).expanduser().resolve()
    roots = [primary_root]
    for root in configured_workspace_roots():
        if not any(_inside(root, existing) or _inside(existing, root) for existing in roots):
            roots.append(root)
    return roots


def add_workspace_root(path: str | Path, *, primary: str | Path) -> Path:
    """Persist an additional, pre-trusted directory outside the primary root."""
    root = Path(path).expanduser().resolve()
    primary_root = Path(primary).expanduser().resolve()
    if not root.is_dir():
        raise WorkspaceRootError("additional workspace root must be an existing directory")
    if not is_workspace_trusted(root):
        raise WorkspaceRootError("additional workspace root must be trusted before it can be added")
    existing = authorized_workspace_roots(primary_root)
    if any(_inside(root, item) or _inside(item, root) for item in existing):
        raise WorkspaceRootError("directory is already covered by an authorized workspace root")
    roots = configured_workspace_roots()
    roots.append(root)
    _save_state(roots)
    return root


def remove_workspace_root(path: str | Path) -> bool:
    """Remove one persisted root; this does not revoke the separate trust decision."""
    target = Path(path).expanduser().resolve()
    roots = configured_workspace_roots()
    retained = [root for root in roots if root != target]
    if len(retained) == len(roots):
        return False
    _save_state(retained)
    return True


def path_is_authorized(path: str | Path, *, primary: str | Path) -> bool:
    """Return whether an already-resolved path belongs to any authorized root."""
    candidate = Path(path).expanduser().resolve()
    return any(_inside(candidate, root) for root in authorized_workspace_roots(primary))
