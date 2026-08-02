"""Canonical runtime paths for isolated Arforge profiles."""

from __future__ import annotations

import os
from pathlib import Path


def get_arforge_home() -> Path:
    """Return the active profile directory without creating it."""
    configured = os.environ.get("ARFORGE_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".arforge").resolve()


def data_path(*parts: str) -> Path:
    """Resolve a path below the active profile."""
    return get_arforge_home().joinpath(*parts)
