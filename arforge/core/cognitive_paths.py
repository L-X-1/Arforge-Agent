"""Workspace-scoped persistence paths for cognitive runtime artifacts."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from arforge.paths import get_arforge_home


def workspace_cognitive_root(
    workspace_root: str | Path,
    *,
    data_root: str | Path | None = None,
) -> Path:
    """Return a stable profile path without exposing the workspace path.

    The resolved, normalized workspace identity is hashed rather than embedded
    in filenames.  This prevents accidental cross-project replay while keeping
    profile directories portable and free of potentially sensitive path text.
    """
    workspace = Path(workspace_root).expanduser().resolve()
    normalized = os.path.normcase(str(workspace)).replace("\\", "/")
    workspace_id = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]
    profile = Path(data_root).expanduser().resolve() if data_root is not None else get_arforge_home()
    return profile / "cognitive-runs" / "workspaces" / workspace_id


__all__ = ["workspace_cognitive_root"]
