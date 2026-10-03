"""Read-only workspace authorization bridge owned by the TypeScript CLI.

Legacy Python tools still need a path admission decision during the migration
window.  They must not read or write ``workspace_roots.json`` themselves, so
this module asks the canonical TypeScript/Core ``workspace list --json``
projection for the currently authorized roots and performs only the final
containment check locally.  A malformed/failed bridge is always fail-closed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from arforge.cli_compat import invoke


_CACHE: dict[tuple[str, str], tuple[tuple[object, ...], tuple[Path, ...] | None]] = {}


def _canonical(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def _state_fingerprint() -> tuple[object, ...]:
    """Return a cheap identity for TS-owned profile state and trust bypass."""

    home = Path(os.environ.get("ARFORGE_HOME", str(Path.home() / ".arforge"))).expanduser()
    values: list[object] = [str(home.resolve()), os.environ.get("ARFORGE_TRUST_WORKSPACE", "")]
    for name in ("trusted_workspaces.json", "workspace_roots.json"):
        path = home / name
        try:
            info = path.stat()
        except OSError:
            values.extend([name, None])
        else:
            values.extend([name, info.st_mtime_ns, info.st_size])
    return tuple(values)


def _payload_roots(payload: Any, primary: Path) -> tuple[Path, ...] | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("primary"), str):
        return None
    reported_primary = _canonical(payload["primary"])
    if reported_primary != primary:
        return None
    raw_roots = payload.get("roots")
    if not isinstance(raw_roots, list):
        return None

    roots: list[Path] = []
    for item in raw_roots:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("path"), str)
            or not isinstance(item.get("primary"), bool)
            or not isinstance(item.get("trusted"), bool)
        ):
            return None
        try:
            root = _canonical(item["path"])
        except (OSError, RuntimeError, ValueError):
            return None
        if item["primary"] != (root == primary):
            return None
        # The primary root is always part of the projection; every additional
        # root must carry an explicit persisted trust bit from the TS owner.
        if root != primary and item["trusted"] is not True:
            return None
        if root not in roots:
            roots.append(root)
    if primary not in roots:
        return None
    return tuple(roots)


def typescript_workspace_roots(
    primary: str | Path,
    *,
    force_refresh: bool = False,
) -> tuple[Path, ...] | None:
    """Return TS/Core authorized roots, or ``None`` when the bridge is unsafe."""

    root = _canonical(primary)
    cache_key = (str(root), str(Path(os.environ.get("ARFORGE_HOME", "")).expanduser()))
    fingerprint = _state_fingerprint()
    cached = _CACHE.get(cache_key)
    if not force_refresh and cached is not None and cached[0] == fingerprint:
        return cached[1]

    try:
        result = invoke(
            ["workspace", "list", "--workspace", str(root), "--json"],
            cwd=str(root),
            env={
                # The workspace projection is file-backed and must not inherit
                # a live database URL from a host process.
                "ARFORGE_DB": ":memory:",
                "ARFORGE_DB_URL": "",
                "DATABASE_URL": "",
                "NO_COLOR": "1",
            },
            timeout=15,
        )
        if result.returncode != 0:
            roots = None
        else:
            roots = _payload_roots(json.loads(result.stdout), root)
    except (OSError, TypeError, ValueError, RuntimeError, json.JSONDecodeError):
        roots = None

    _CACHE[cache_key] = (fingerprint, roots)
    return roots


def typescript_path_is_authorized(path: str | Path, *, primary: str | Path) -> bool:
    """Check containment against the canonical TS/Core root projection."""

    try:
        candidate = _canonical(path)
        roots = typescript_workspace_roots(primary)
        if roots is None:
            return False
        return any(candidate == root or root in candidate.parents for root in roots)
    except (OSError, RuntimeError, ValueError):
        return False


def clear_typescript_workspace_cache() -> None:
    """Test/support hook; production callers rely on fingerprint invalidation."""

    _CACHE.clear()


__all__ = [
    "clear_typescript_workspace_cache",
    "typescript_path_is_authorized",
    "typescript_workspace_roots",
]
