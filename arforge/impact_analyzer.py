"""Multi-dimensional impact analysis — BFS depth, reference count, test coverage.

Replaces hardcoded "medium"/"high" risk with a weighted scoring formula:
  risk_score = depth_factor * 0.4 + log(refs) * 0.4 - has_test * 0.2
"""

from __future__ import annotations

import math
from pathlib import Path


def analyze_file_impact(file_path: str, max_depth: int = 3) -> dict:
    """Analyze the impact of changing a file.

    Computes:
    - reverse_dependency_depth: BFS max 3 layers of dependents
    - reference_count: number of inbound references
    - has_tests: whether a corresponding test file exists
    - risk_score: weighted formula (0-5 scale)
    - risk_level: "low" / "medium" / "high" / "critical"
    """
    path = Path(file_path)
    reverse_deps = _reverse_deps(path, max_depth)
    depth = _bfs_depth(reverse_deps, str(path))
    refs = _count_references(file_path)
    has_test = _has_test_file(path)
    test_coverage_note = _detect_test_coverage(path)

    # Weighted scoring
    depth_factor = min(depth, 5)
    ref_factor = math.log(max(refs, 1) + 1)
    test_penalty = 0.5 if has_test else 0

    risk_score = depth_factor * 0.4 + ref_factor * 0.4 - test_penalty * 0.2

    # Thresholds
    if risk_score < 1.0:
        risk_level = "low"
    elif risk_score < 2.5:
        risk_level = "medium"
    elif risk_score < 4.0:
        risk_level = "high"
    else:
        risk_level = "critical"

    rev_deps_list = reverse_deps.get(str(path), [])[:10]
    return {
        "file": str(path),
        "risk": risk_level,
        "risk_score": round(risk_score, 2),
        "reverse_dependencies": rev_deps_list,  # backward-compat key
        "risk_factors": {
            "reverse_dependency_depth": depth,
            "reference_count": refs,
            "has_tests": has_test,
            "test_coverage": test_coverage_note,
        },
        "evidence": {
            "reverse_dependencies": rev_deps_list,
            "test_files": _find_test_files(path),
        },
    }


def analyze_symbol_impact(symbol_name: str) -> dict:
    """Analyze the impact of changing a symbol."""
    try:
        from arforge.reference_indexer import find_references
        refs = find_references(symbol_name, limit=100)
    except Exception:
        refs = []

    ref_count = len(refs)
    if ref_count > 50:
        risk_level = "critical"
        risk_score = 4.5
    elif ref_count > 20:
        risk_level = "high"
        risk_score = 3.0
    elif ref_count > 5:
        risk_level = "medium"
        risk_score = 1.8
    else:
        risk_level = "low"
        risk_score = 0.5

    return {
        "symbol": symbol_name,
        "references": refs[:20],
        "reference_count": ref_count,
        "risk": risk_level,
        "risk_score": risk_score,
        "risk_factors": {"reference_count": ref_count},
    }


def analyze_change_impact(target: str) -> dict:
    """Unified entry point: detects file vs symbol and dispatches."""
    if target.endswith(".py") or "/" in target or "\\" in target:
        return analyze_file_impact(target)
    return analyze_symbol_impact(target)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _reverse_deps(path: Path, max_depth: int) -> dict[str, list[str]]:
    """Build a reverse dependency map via BFS up to max_depth."""
    try:
        from arforge.dependency_graph import list_reverse_dependencies
        deps = list_reverse_dependencies(str(path))
        # Normalize: dependents may be strings or dicts
        normalized = []
        for d in deps:
            if isinstance(d, str):
                normalized.append(d)
            elif isinstance(d, dict):
                normalized.append(d.get("file", d.get("path", str(d))))
            else:
                normalized.append(str(d))
        return {str(path): normalized[:20]}
    except Exception:
        return {str(path): []}


def _bfs_depth(deps: dict[str, list[str]], root: str) -> int:
    """Compute BFS depth of the dependency tree."""
    visited: set[str] = {root}
    frontier = [root]
    depth = 0
    while frontier and depth < 10:
        next_frontier = []
        for node in frontier:
            for child in deps.get(node, []):
                if child not in visited:
                    visited.add(child)
                    next_frontier.append(child)
        if next_frontier:
            depth += 1
        frontier = next_frontier
    return depth


def _count_references(file_path: str) -> int:
    """Count inbound references to symbols defined in this file."""
    path = Path(file_path)
    try:
        from arforge.python_ast_indexer import list_file_symbols
        from arforge.reference_indexer import find_references

        symbols = list_file_symbols(str(path))
        total = 0
        for sym in symbols[:10]:
            refs = find_references(sym.get("name", ""), limit=50)
            total += len(refs)
        return total
    except Exception:
        return 0


def _has_test_file(path: Path) -> bool:
    """Check if a corresponding test file exists."""
    test_paths = _find_test_files(path)
    return len(test_paths) > 0


def _find_test_files(path: Path) -> list[str]:
    """Find test files that likely cover this source file."""
    stem = path.stem
    resolved = path.resolve()
    parent = resolved.parent
    project_root = _find_project_root(parent)
    test_candidates = [
        parent / f"test_{stem}.py",
        parent / f"{stem}_test.py",
        project_root / "tests" / f"test_{stem}.py",
        project_root / "tests" / f"{stem}_test.py",
        project_root / "test" / f"test_{stem}.py",
        project_root / "test" / f"{stem}_test.py",
    ]
    existing: list[str] = []
    for candidate in test_candidates:
        if candidate.exists():
            existing.append(str(candidate))
    if existing:
        return list(dict.fromkeys(existing))

    # Restrict recursive discovery to conventional test roots. Searching the
    # whole repository traverses dependency caches and language toolchains
    # before it can discover that their files do not match.
    for test_root in (project_root / "tests", project_root / "test"):
        if not test_root.is_dir():
            continue
        try:
            for pattern in (f"test_{stem}.py", f"{stem}_test.py"):
                found = next(test_root.rglob(pattern), None)
                if found is not None:
                    return [str(found)]
        except OSError:
            continue
    return existing


def _find_project_root(start: Path) -> Path:
    current = start
    while True:
        if any((current / marker).exists() for marker in (".git", "pyproject.toml", "package.json")):
            return current
        if current.parent == current:
            return start
        current = current.parent


def _detect_test_coverage(path: Path) -> str:
    """Return a note about test coverage detection."""
    test_files = _find_test_files(path)
    if not test_files:
        return "no test file detected"
    return f"test file(s) found: {', '.join(test_files)}"
