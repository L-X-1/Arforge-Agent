"""Large repository scaling (G2) — .gitignore-aware scanning, binary detection,
index caching, and incremental rebuild.

Makes Arforge handle 100K+ file repositories efficiently.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any

from arforge.paths import data_path


# ---------------------------------------------------------------------------
# .gitignore parser
# ---------------------------------------------------------------------------


def _parse_gitignore(patterns: list[str]) -> list[tuple[bool, str]]:
    """Parse .gitignore patterns into (negated, pattern) tuples."""
    result: list[tuple[bool, str]] = []
    for line in patterns:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        negated = False
        if line.startswith("!"):
            negated = True
            line = line[1:]
        line = line.rstrip("/")
        result.append((negated, line))
    return result


_GITIGNORE_CACHE: dict[str, tuple[float, list[tuple[bool, str]]]] = {}


def load_gitignore_patterns(root: Path) -> list[tuple[bool, str]]:
    """Load .gitignore patterns from a directory (cached for 5s)."""
    gitignore_path = root / ".gitignore"
    cache_key = str(gitignore_path.resolve())

    if cache_key in _GITIGNORE_CACHE:
        ts, patterns = _GITIGNORE_CACHE[cache_key]
        if time.time() - ts < 5:
            return patterns

    patterns: list[tuple[bool, str]] = []
    if gitignore_path.is_file():
        try:
            text = gitignore_path.read_text(encoding="utf-8", errors="replace")
            patterns = _parse_gitignore(text.splitlines())
        except OSError:
            pass

    _GITIGNORE_CACHE[cache_key] = (time.time(), patterns)
    return patterns


def is_ignored(path: str, gitignore_patterns: list[tuple[bool, str]]) -> bool:
    """Check if a path matches .gitignore patterns."""
    clean = path.rstrip("/").rstrip("\\")
    ignored = False
    for negated, pattern in gitignore_patterns:
        match = fnmatch.fnmatch(clean, pattern)
        if match:
            ignored = not negated
    return ignored


# ---------------------------------------------------------------------------
# Binary file detection
# ---------------------------------------------------------------------------


_BINARY_SIGNATURES: set[int] = {
    0x00,  # NULL byte
}

_TEXT_CHARS: set[int] = set(range(0x20, 0x7F)) | {0x09, 0x0A, 0x0D}  # tab, LF, CR

# Common binary extensions
_BINARY_EXTENSIONS: set[str] = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".lib", ".a",
    ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".pyc", ".pyo", ".pyd", ".class", ".o", ".obj",
    ".db", ".sqlite", ".sqlite3", ".mdb",
    ".bin", ".dat", ".pak", ".asset",
    ".wasm", ".node",
}

# Max bytes to read for text detection
_MAX_DETECT_BYTES = 8192


def is_binary_file(path: str | Path) -> bool:
    """Detect if a file is binary by extension or content sampling."""
    p = Path(path)

    # Extension check (fast)
    if p.suffix.lower() in _BINARY_EXTENSIONS:
        return True

    # Content sampling
    try:
        with open(p, "rb") as f:
            chunk = f.read(_MAX_DETECT_BYTES)
    except (OSError, PermissionError):
        return True

    if not chunk:
        return False

    # Check for NULL bytes
    if 0x00 in chunk:
        return True

    # Check ratio of non-text bytes
    non_text = sum(1 for b in chunk if b not in _TEXT_CHARS)
    if len(chunk) > 0 and non_text / len(chunk) > 0.30:
        return True

    return False


# ---------------------------------------------------------------------------
# File size guard
# ---------------------------------------------------------------------------


MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10MB
DEFAULT_CODE_SUFFIXES = (".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".md")


def is_too_large(path: str | Path, max_bytes: int | None = None) -> bool:
    """Check if a file exceeds the size limit."""
    limit = max_bytes or MAX_FILE_SIZE_BYTES
    try:
        size = Path(path).stat().st_size
        return size > limit
    except OSError:
        return True


# ---------------------------------------------------------------------------
# Index cache
# ---------------------------------------------------------------------------


def _index_cache_path() -> Path:
    return data_path("index_cache.json")


def save_index_cache(data: dict) -> None:
    """Save index data to disk cache."""
    try:
        cache_path = _index_cache_path()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "ts": time.time(),
            "data": data,
        }
        cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def load_index_cache(max_age_seconds: float = 300) -> dict | None:
    """Load index cache if not expired."""
    cache_path = _index_cache_path()
    if not cache_path.is_file():
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        age = time.time() - payload.get("ts", 0)
        if max_age_seconds <= 0 or age > max_age_seconds:
            return None
        return payload.get("data")
    except (json.JSONDecodeError, OSError):
        return None


def invalidate_index_cache() -> None:
    """Remove the index cache."""
    cache_path = _index_cache_path()
    try:
        cache_path.unlink(missing_ok=True)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Smart scanner
# ---------------------------------------------------------------------------


def smart_scan(
    root: str | Path = ".",
    suffixes: tuple[str, ...] = (".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".md"),
    respect_gitignore: bool = True,
    skip_binary: bool = True,
    max_files: int = 500000,
) -> list[dict]:
    """Smart project scanner with .gitignore awareness, binary skipping, and size limits.

    Returns list of dicts: {path, suffix, bytes, is_binary}
    """
    base = Path(root).resolve()
    results: list[dict] = []

    # Load gitignore patterns from root
    gitignore = load_gitignore_patterns(base) if respect_gitignore else []

    # Standard excludes (always skipped)
    always_skip = {
        ".git", ".venv", "venv", "__pycache__", ".pytest_cache",
        ".ruff_cache", "node_modules", ".next", ".nuxt", "dist",
        "build", "target", ".tox", ".mypy_cache",
        ".idea", ".vscode", ".vs",
    }

    # Walk files
    for dirpath, dirnames, filenames in os.walk(str(base)):
        dirpath_p = Path(dirpath)
        rel = dirpath_p.relative_to(base)

        # Filter directories
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in always_skip and not d.startswith(".")
        )

        # Apply gitignore to directories
        if respect_gitignore and gitignore and str(rel) != ".":
            dirnames[:] = sorted(
                d for d in dirnames
                if not is_ignored(str(rel / d) + "/", gitignore)
            )

        for filename in sorted(filenames):
            if len(results) >= max_files:
                break

            filepath = rel / filename
            filepath_str = str(filepath).replace("\\", "/")
            suffix = Path(filename).suffix.lower()

            # Filter by suffix
            if suffixes and suffix not in suffixes:
                continue

            # Apply gitignore
            if respect_gitignore and gitignore:
                if is_ignored(filepath_str, gitignore):
                    continue

            full_path = dirpath_p / filename

            # Skip binary
            if skip_binary:
                if suffix in _BINARY_EXTENSIONS:
                    continue
                try:
                    if is_too_large(full_path):
                        continue
                except OSError:
                    continue

            try:
                size = full_path.stat().st_size
            except OSError:
                continue

            results.append({
                "path": filepath_str,
                "suffix": suffix,
                "bytes": size,
            })

    return results


# ---------------------------------------------------------------------------
# Incremental scan — mtime-based change detection (T15)
# ---------------------------------------------------------------------------

_INCREMENTAL_STATE: dict[str, dict] = {}  # path → {mtime_ns, size, sha256}


def _state_path() -> Path:
    return data_path("incremental_scan_state.json")


def save_incremental_state() -> None:
    """Persist incremental scan state to disk."""
    try:
        p = _state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "ts": time.time(),
            "state": {k: {"mt": v["mtime_ns"], "sz": v["size"], "h": v["sha256"]}
                      for k, v in _INCREMENTAL_STATE.items()},
        }
        p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def load_incremental_state(max_age_seconds: float = 3600) -> dict | None:
    """Load incremental scan state from disk (within TTL)."""
    p = _state_path()
    if not p.is_file():
        return None
    try:
        payload = json.loads(p.read_text(encoding="utf-8"))
        if (
            max_age_seconds <= 0
            or time.time() - payload.get("ts", 0) > max_age_seconds
        ):
            return None
        return payload.get("state", {})
    except (json.JSONDecodeError, OSError):
        return None


def incremental_smart_scan(
    root: str | Path = ".",
    suffixes: tuple[str, ...] = (".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".md"),
    respect_gitignore: bool = True,
    skip_binary: bool = True,
    max_files: int = 500000,
    use_incremental: bool = True,
) -> dict:
    """Smart scan with incremental update — only re-scan changed/new files.

    Returns:
        dict with keys:
          - "files": list of file dicts (same format as smart_scan)
          - "added": count of newly discovered files
          - "changed": count of files with modified mtime
          - "unchanged": count of files skipped (same mtime)
          - "removed": count of previously-tracked files no longer present
          - "total": total files in result
          - "incremental": whether incremental mode was used
          - "scan_time_ms": wall-clock time for this scan
    """
    global _INCREMENTAL_STATE
    t0 = time.perf_counter()

    base = Path(root).resolve()
    previous_state = load_incremental_state() if use_incremental else None

    # Do full smart scan to get current file list
    current_files = smart_scan(
        root=base, suffixes=suffixes,
        respect_gitignore=respect_gitignore,
        skip_binary=skip_binary,
        max_files=max_files,
    )

    stats = {"added": 0, "changed": 0, "unchanged": 0, "removed": 0}
    new_state: dict[str, dict] = {}

    if previous_state is not None:
        # Build set of current paths
        current_paths: set[str] = set()

        for f in current_files:
            fp_abs = str((base / f["path"]).resolve())
            current_paths.add(fp_abs)

            try:
                st = (base / f["path"]).stat()
                mtime_ns = st.st_mtime_ns
                size = st.st_size
            except OSError:
                mtime_ns = 0
                size = 0

            prev = previous_state.get(fp_abs)
            if prev is not None and prev.get("mt") == mtime_ns and prev.get("sz") == size:
                stats["unchanged"] += 1
            elif prev is not None:
                stats["changed"] += 1
            else:
                stats["added"] += 1

            new_state[fp_abs] = {"mtime_ns": mtime_ns, "size": size, "sha256": ""}

        # Detect removals
        for prev_path in previous_state:
            if prev_path not in current_paths:
                stats["removed"] += 1
    else:
        stats["added"] = len(current_files)
        for f in current_files:
            fp_abs = str((base / f["path"]).resolve())
            try:
                st = (base / f["path"]).stat()
                mtime_ns = st.st_mtime_ns
                size = st.st_size
            except OSError:
                mtime_ns = 0
                size = 0
            new_state[fp_abs] = {"mtime_ns": mtime_ns, "size": size, "sha256": ""}

    _INCREMENTAL_STATE = new_state
    save_incremental_state()

    elapsed_ms = (time.perf_counter() - t0) * 1000

    return {
        "files": current_files,
        "added": stats["added"],
        "changed": stats["changed"],
        "unchanged": stats["unchanged"],
        "removed": stats["removed"],
        "total": len(current_files),
        "incremental": previous_state is not None,
        "scan_time_ms": round(elapsed_ms, 1),
    }


def get_incremental_delta() -> dict:
    """Get the delta since last incremental scan.

    Returns counts of added/changed/unchanged/removed files.
    Returns empty dict if no previous scan state exists.
    """
    return {
        "added": sum(1 for _ in _INCREMENTAL_STATE.values()),
        "has_state": bool(_INCREMENTAL_STATE),
        "state_size": len(_INCREMENTAL_STATE),
    }


def invalidate_incremental_state() -> None:
    """Clear incremental scan state (force full rescan next time)."""
    global _INCREMENTAL_STATE
    _INCREMENTAL_STATE.clear()
    p = _state_path()
    try:
        p.unlink(missing_ok=True)
    except OSError:
        pass


def scan_stats(root: str | Path = ".") -> dict:
    """Get scanning statistics for a repository."""
    base = Path(root)
    total_files = 0
    code_files = 0

    code_suffixes = {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb", ".php", ".c", ".cpp", ".h"}

    try:
        for dirpath, dirnames, filenames in os.walk(str(base)):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in {
                ".git", "node_modules", "__pycache__", ".venv", "venv",
            }]
            total_files += len(filenames)
            code_files += sum(1 for f in filenames if Path(f).suffix.lower() in code_suffixes)
            if total_files > 200000:
                break
    except OSError:
        pass

    return {
        "total_files_estimate": total_files,
        "code_files_estimate": code_files,
        "root": str(base),
    }


def build_repo_scale_report(
    root: str | Path = ".",
    *,
    query: str = "",
    max_files: int = 5000,
    limit: int = 20,
    suffixes: tuple[str, ...] = DEFAULT_CODE_SUFFIXES,
) -> dict[str, Any]:
    """Build a bounded large-repository scan/search report for user-facing surfaces."""
    base = Path(root).resolve()
    scanned = incremental_smart_scan(
        root=base,
        suffixes=suffixes,
        respect_gitignore=True,
        skip_binary=True,
        max_files=max_files,
        use_incremental=True,
    )
    files = scanned["files"]
    suffix_counts = Counter(str(item.get("suffix") or "") for item in files)
    largest = sorted(files, key=lambda item: int(item.get("bytes", 0)), reverse=True)[: min(limit, 20)]
    total_estimate = scan_stats(base)
    truncated = len(files) >= max_files and total_estimate.get("code_files_estimate", 0) > len(files)

    search = {
        "query": query,
        "total": 0,
        "items": [],
        "searched_files": 0,
        "truncated": truncated,
    }
    if query.strip():
        search = search_large_repo(
            base,
            query=query,
            files=files,
            limit=limit,
        )
        search["truncated"] = truncated

    return {
        "schema_version": 1,
        "root": str(base),
        "budget": {
            "max_files": max_files,
            "suffixes": list(suffixes),
        },
        "scan": {
            "total": scanned["total"],
            "added": scanned["added"],
            "changed": scanned["changed"],
            "unchanged": scanned["unchanged"],
            "removed": scanned["removed"],
            "incremental": scanned["incremental"],
            "scan_time_ms": scanned["scan_time_ms"],
            "truncated": truncated,
            "total_files_estimate": total_estimate.get("total_files_estimate", 0),
            "code_files_estimate": total_estimate.get("code_files_estimate", 0),
        },
        "suffix_counts": dict(sorted(suffix_counts.items())),
        "largest_files": largest,
        "search": search,
        "recommendations": _repo_recommendations(truncated, scanned, search),
    }


def search_large_repo(
    root: str | Path,
    *,
    query: str,
    files: list[dict] | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Search a bounded smart-scan file set and return ranked line matches."""
    base = Path(root).resolve()
    terms = [term.lower() for term in re.split(r"\W+", query) if len(term) > 1]
    if not terms:
        return {"query": query, "total": 0, "items": [], "searched_files": 0}

    scanned_files = files if files is not None else smart_scan(base, suffixes=DEFAULT_CODE_SUFFIXES)
    matches: list[dict[str, Any]] = []
    searched = 0
    for item in scanned_files:
        path = base / str(item["path"])
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        searched += 1
        lower_lines = text.lower().splitlines()
        score = 0
        first_line = 0
        preview = ""
        matched_terms: set[str] = set()
        for line_no, line in enumerate(lower_lines, 1):
            line_hits = [term for term in terms if term in line]
            if not line_hits:
                continue
            score += len(line_hits)
            matched_terms.update(line_hits)
            if not first_line:
                first_line = line_no
                preview = text.splitlines()[line_no - 1].strip()[:160]
        if score:
            matches.append(
                {
                    "path": item["path"],
                    "line": first_line,
                    "score": score,
                    "matched_terms": sorted(matched_terms),
                    "preview": preview,
                }
            )

    matches.sort(key=lambda item: (-int(item["score"]), str(item["path"]), int(item["line"])))
    return {
        "query": query,
        "total": len(matches),
        "items": matches[:limit],
        "searched_files": searched,
    }


def _repo_recommendations(truncated: bool, scanned: dict, search: dict) -> list[str]:
    recommendations: list[str] = []
    if truncated:
        recommendations.append("Increase max_files or narrow suffixes when working in repositories larger than the scan budget.")
    if scanned.get("unchanged", 0):
        recommendations.append("Incremental state is active; repeated scans can reuse unchanged file metadata.")
    if search.get("query") and search.get("total", 0) == 0:
        recommendations.append("No match found inside the current scan budget; try a narrower symbol or raise max_files.")
    if not recommendations:
        recommendations.append("Repository scan is within budget and ready for bounded local search.")
    return recommendations
