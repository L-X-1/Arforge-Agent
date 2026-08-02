"""Project filesystem scanning."""

from __future__ import annotations

import os
from pathlib import Path


DEFAULT_EXCLUDES = {
    ".arforge",
    ".arforge-acceptance-workspaces",
    ".arforge-bridge-smoke",
    ".arforge-run",
    ".arforge-worktrees",
    ".codex-doc-review",
    ".git",
    ".tools",
    ".tmp",
    ".turbo",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".pytest-tmp",
    ".ruff_cache",
    ".mypy_cache",
    ".tox",
    "artifacts",
    "coverage",
    "node_modules",
    "out",
    "target",
    "dist",
    "build",
    "tmp",
    "workspace",
    ".recovery" + "_pyc",
}


def _project_sort_key(item: dict) -> tuple[int, str]:
    """Keep active Arforge source files visible in truncated project views."""
    path = str(item["path"]).replace("\\", "/")
    if path.startswith("arforge/"):
        rank = 0
    else:
        rank = 1
    return (rank, path)


def scan_project(
    root: str | Path = ".",
    suffixes: tuple[str, ...] | None = (".py", ".md", ".toml", ".json"),
) -> list[dict]:
    """Return project files, or every non-excluded file when ``suffixes`` is None."""
    base = Path(root).resolve()
    results = []
    # ``Path.rglob`` still descends into excluded directories before the
    # per-path filter runs.  Large dependency/build trees therefore made a
    # simple code search consume a CPU core for minutes.  Prune directories
    # during traversal so excluded trees are never enumerated.
    for directory, dirnames, filenames in os.walk(base, topdown=True):
        dirnames[:] = [
            name
            for name in dirnames
            if name not in DEFAULT_EXCLUDES
        ]
        parent = Path(directory)
        for filename in filenames:
            path = parent / filename
            if suffixes is not None and path.suffix not in suffixes:
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            results.append(
                {
                    "path": str(path.relative_to(base)),
                    "suffix": path.suffix,
                    "bytes": size,
                }
            )
    return sorted(results, key=_project_sort_key)


def build_project_tree(root: str | Path = ".", max_files: int = 200) -> str:
    files = scan_project(root)[:max_files]
    return "\n".join(item["path"] for item in files)
