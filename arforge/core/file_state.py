"""File state tracking (WP-06) -- hash/mtime-based cache with stale detection.

Tracks every file read by the agent during a run. When a file is re-read and its
mtime/hash hasn't changed, the cached read is reused (saving tokens). When a file
has been externally modified, the agent is notified that its knowledge is stale.

Key design decisions:
- Per-run scope: cache lives for one AgentRun, cleared on completion.
- Hash-based: uses SHA-256 of content for reliable change detection.
- Lightweight: only tracks files the agent actually reads (not the whole repo).
"""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class FileState:
    """Snapshot of a file at the time it was read."""

    path: str
    mtime: float
    size: int
    sha256: str
    content: str | None = None  # Cached content (optional, for small files)
    read_count: int = 1
    first_read_at: float = 0.0
    last_read_at: float = 0.0
    _mtime_ns: int = 0  # Nanosecond-precision mtime (set alongside mtime for precision)

    @property
    def size_bytes(self) -> int:
        return self.size

    @property
    def mtime_ns(self) -> int:
        if self._mtime_ns:
            return self._mtime_ns
        return round(self.mtime * 1e9)

    def to_dict(self) -> dict:
        """Serialise to dict for Bridge/CLI reporting."""
        return {
            "path": self.path,
            "mtime": self.mtime,
            "size": self.size,
            "sha256": self.sha256,
            "read_count": self.read_count,
            "first_read_at": self.first_read_at,
            "last_read_at": self.last_read_at,
        }


class FileStateTracker:
    """Per-run file state cache with stale detection.

    Usage::

        tracker = FileStateTracker()
        content, is_stale = tracker.read("src/main.py")
        if is_stale:
            print("File was modified externally!")
    """

    def __init__(self, max_cache_files: int = 200, max_content_bytes: int = 100_000):
        self._states: dict[str, FileState] = {}
        self.max_cache_files = max_cache_files
        self.max_content_bytes = max_content_bytes
        self._total_bytes_cached = 0

    # -- public API ----------------------------------------------------------

    def observe(self, path: str | Path, content: str | None = None) -> FileState:
        """Record a file observation and return its state snapshot.

        This is the primary API called by tools (file_tools, code_tools).
        If content is not provided, it reads the file from disk.
        """
        resolved = str(Path(path).resolve())
        now = time.time()

        try:
            stat = os.stat(resolved)
            current_mtime = stat.st_mtime
            current_size = stat.st_size
        except OSError:
            # File doesn't exist -- create a minimal state
            state = FileState(
                path=resolved,
                mtime=0.0,
                size=0,
                sha256="",
                content=None,
                read_count=1,
                first_read_at=now,
                last_read_at=now,
            )
            self._states[resolved] = state
            return state

        if content is None:
            try:
                content = Path(resolved).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                content = f"[binary file, {current_size} bytes]"

        sha = hashlib.sha256(content.encode("utf-8", errors="replace")).hexdigest()

        # Check existing cache
        cached = self._states.get(resolved)
        if cached is not None and cached.mtime == current_mtime and cached.size == current_size:
            cached.read_count += 1
            cached.last_read_at = now
            return cached

        state = FileState(
            path=resolved,
            mtime=current_mtime,
            size=current_size,
            sha256=sha,
            _mtime_ns=stat.st_mtime_ns,
            content=content if len(content) <= self.max_content_bytes else None,
            read_count=1,
            first_read_at=now,
            last_read_at=now,
        )
        self._states[resolved] = state
        return state

    def get(self, path: str | Path) -> FileState | None:
        """Return the tracked state for a path, or None if not observed."""
        resolved = str(Path(path).resolve())
        return self._states.get(resolved)

    def read(self, path: str | Path) -> tuple[str | None, bool]:
        """Read a file, returning (content, is_stale).

        - First read: returns (content, False), caches state.
        - Re-read unchanged: returns (cached_content, False), increments counter.
        - Re-read changed: returns (new_content, True), updates cache.
        """
        resolved = str(Path(path).resolve())
        cached = self._states.get(resolved)  # Snapshot BEFORE observe replaces it
        state = self.observe(resolved)

        is_stale = False
        if cached is not None and state.sha256 != cached.sha256:
            is_stale = True
            # Re-read to get fresh content
            try:
                fresh_content = Path(resolved).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                fresh_content = None
            return fresh_content, is_stale

        return state.content, is_stale

    def invalidate(self, path: str | Path) -> None:
        """Force-invalidate cached state for a path (e.g., after our own write)."""
        resolved = str(Path(path).resolve())
        self._states.pop(resolved, None)

    def is_stale(self, path: str | Path) -> bool:
        """Check if a previously-read file has been modified externally."""
        resolved = str(Path(path).resolve())
        cached = self._states.get(resolved)
        if cached is None:
            return False
        try:
            stat = os.stat(resolved)
            return stat.st_mtime != cached.mtime or stat.st_size != cached.size
        except OSError:
            return True  # File disappeared

    def list_observed(self):
        """Return all observed file states."""
        return [self._states[p] for p in sorted(self._states)]

    def list(self):
        return self.list_observed()

    def list_dicts(self) -> list[dict]:
        """Return observed states as dicts (for Bridge/CLI serialisation)."""
        return [s.to_dict() for s in self.list_observed()]

    def count_avoidable_reads(self) -> int:
        """Count how many re-reads could have been avoided via caching."""
        return sum(s.read_count - 1 for s in self._states.values() if s.read_count > 1)

    def get_stats(self) -> dict:
        """Return tracking statistics for the run report."""
        total_reads = sum(s.read_count for s in self._states.values())
        cached_hits = sum(s.read_count - 1 for s in self._states.values())
        stale_count = sum(1 for p in self._states if self.is_stale(p))
        return {
            "files_tracked": len(self._states),
            "total_reads": total_reads,
            "cache_hits": cached_hits,
            "stale_detected": stale_count,
            "bytes_cached": self._total_bytes_cached,
            "avoidable_reads": self.count_avoidable_reads(),
        }

    def clear(self) -> None:
        """Clear all tracked state (called at end of run)."""
        self._states.clear()
        self._total_bytes_cached = 0


# --- module-level convenience -------------------------------------------------

_tracker: FileStateTracker | None = None


def get_file_state_tracker() -> FileStateTracker:
    """Return the per-run singleton FileStateTracker, creating it on first call."""
    global _tracker
    if _tracker is None:
        _tracker = FileStateTracker()
    return _tracker


def reset_file_state_tracker() -> None:
    """Reset the module-level singleton tracker (used in tests and between runs)."""
    global _tracker
    _tracker = None


def snapshot_file(path: str | Path) -> FileState | None:
    """Take a snapshot of a file's current state (used before writes for rollback)."""
    resolved = str(Path(path).resolve())
    try:
        stat = os.stat(resolved)
        content = Path(resolved).read_text(encoding="utf-8")
        sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
        return FileState(
            path=resolved,
            mtime=stat.st_mtime,
            size=stat.st_size,
            sha256=sha,
            _mtime_ns=stat.st_mtime_ns,
            content=content,
            first_read_at=time.time(),
            last_read_at=time.time(),
        )
    except OSError:
        return None
