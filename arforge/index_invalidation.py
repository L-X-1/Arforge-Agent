"""Index invalidation and incremental update — mtime-based dirty detection.

Monitors file modification times so indices (AST, TF-IDF, reference, call-graph)
are rebuilt incrementally instead of full-scanned on every query.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable


def _state_path() -> Path:
    base = os.environ.get("ARFORGE_HOME", str(Path.home() / ".arforge"))
    return Path(base) / "index_state.json"


def _load_state() -> dict:
    """Load the persisted mtime→index state map."""
    path = _state_path()
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"files": {}, "last_full_build": 0}


def _save_state(state: dict) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def _path_key(path: str | Path) -> str:
    return os.path.normcase(str(Path(path).resolve()))


# ---------------------------------------------------------------------------
# Dirty detection
# ---------------------------------------------------------------------------


def get_dirty_files(root: str | Path = ".", suffixes: tuple[str, ...] = (".py",)) -> list[str]:
    """Return files that have been modified since last index build.

    A file is "dirty" if:
    - It's new (not in the state)
    - Its mtime differs from the saved mtime
    - The last full build timestamp is older than the file
    """
    state = _load_state()
    known = state.get("files", {})
    base = Path(root).resolve()
    dirty: list[str] = []

    for py_file in base.rglob("**/*"):
        if py_file.suffix not in suffixes:
            continue
        _SKIP_DIRS = {"__pycache__", ".venv", "node_modules", ".git", "dist", "build", ".tox", ".eggs"}
        if any(part in _SKIP_DIRS for part in py_file.parts):
            continue
        key = _path_key(py_file)
        try:
            mtime = py_file.stat().st_mtime
        except OSError:
            continue

        if key not in known or known[key] != mtime:
            dirty.append(key)

    # Also detect deleted files
    for key in known:
        if not Path(key).exists():
            dirty.append(key)

    return dirty


def mark_clean(files: list[str]) -> None:
    """Update the mtime state for files that have been freshly indexed."""
    state = _load_state()
    now = time.time()
    for f in files:
        key = _path_key(f)
        try:
            state["files"][key] = Path(f).stat().st_mtime
        except OSError:
            state["files"].pop(key, None)
    state["last_full_build"] = now
    _save_state(state)


def mark_full_rebuild() -> None:
    """Record that a full index rebuild has completed."""
    state = _load_state()
    state["last_full_build"] = time.time()
    _save_state(state)


def is_stale(max_age_seconds: int = 3600) -> bool:
    """Return True if no full build has occurred within max_age_seconds."""
    state = _load_state()
    last = state.get("last_full_build", 0)
    return (time.time() - last) > max_age_seconds


# ---------------------------------------------------------------------------
# Incremental rebuild orchestrator
# ---------------------------------------------------------------------------


def incremental_rebuild(
    root: str | Path = ".",
    rebuild_fn: Callable[[], dict] | None = None,
) -> dict:
    """Detect dirty files and selectively rebuild affected indices.

    If no rebuild_fn is provided, uses the default rebuild path:
    - python_ast_indexer for symbol changes
    - TF-IDF index for token changes
    """
    dirty = get_dirty_files(root)
    if not dirty:
        return {"rebuilt": False, "dirty_files": 0, "message": "all indices up to date"}

    # Rebuild full indices (AST + TF-IDF)
    results = {}
    try:
        from arforge.python_ast_indexer import index_python_ast
        r = index_python_ast(root)
        results["ast"] = r
    except Exception as e:
        results["ast_error"] = str(e)

    try:
        from arforge.code_tfidf_index import get_tfidf_index
        tfidf = get_tfidf_index()
        tfidf_r = tfidf.build(root)
        results["tfidf"] = tfidf_r
    except Exception as e:
        results["tfidf_error"] = str(e)

    mark_clean(dirty)

    if rebuild_fn:
        try:
            custom = rebuild_fn()
            results["custom"] = custom
        except Exception as e:
            results["custom_error"] = str(e)

    return {
        "rebuilt": True,
        "dirty_files": len(dirty),
        "dirty_preview": dirty[:10],
        "results": results,
    }


def health_status() -> dict:
    """Return index health status for doctor display."""
    state = _load_state()
    last_build = state.get("last_full_build", 0)
    file_count = len(state.get("files", {}))
    stale = is_stale()

    return {
        "last_full_build": last_build,
        "last_build_iso": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(last_build)) if last_build else "never",
        "tracked_files": file_count,
        "stale": stale,
        "recommendation": "运行 incremental_rebuild() 以更新索引" if stale else "索引状态正常",
    }
