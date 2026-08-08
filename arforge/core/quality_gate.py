"""G12 quality standards for changed files.

The gate is intentionally scoped to files changed in the current run.  It turns
project-quality expectations into deterministic checks without auditing the
entire historical repository on every task.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable


@dataclass(frozen=True)
class QualityIssue:
    level: str
    code: str
    message: str
    file: str = ""


@dataclass(frozen=True)
class DiffStats:
    files: list[str]
    files_changed: int
    additions: int
    deletions: int
    changed_lines: int
    hunks: int
    new_files: int
    deleted_files: int


_DOC_EXTENSIONS = {".md", ".rst", ".txt"}
_CODE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".toml", ".json", ".yaml", ".yml"}
_GENERATED_PARTS = {"dist", "build", "target", "__pycache__", ".pytest_cache", "node_modules"}
_PUBLIC_SURFACE_PREFIXES = (
    "arforge/cli.py",
    "arforge/product/",
    "desktop/src/types/",
    "docs/",
)


def _normalize(path: str) -> str:
    return str(path).replace("\\", "/").lstrip("./")


def _is_doc(path: str) -> bool:
    return Path(path).suffix.lower() in _DOC_EXTENSIONS or _normalize(path).startswith("docs/")


def _is_code(path: str) -> bool:
    return Path(path).suffix.lower() in _CODE_EXTENSIONS


def _touches_public_surface(path: str) -> bool:
    normalized = _normalize(path)
    return any(normalized == prefix.rstrip("/") or normalized.startswith(prefix) for prefix in _PUBLIC_SURFACE_PREFIXES)


def _looks_generated(path: str) -> bool:
    parts = set(Path(_normalize(path)).parts)
    return bool(parts & _GENERATED_PARTS)


def _default_resolver(path: str) -> Path:
    from arforge.tools.file_tools import _resolve

    return _resolve(path)


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return None


def _patch_path(value: str) -> str:
    cleaned = value.strip().strip('"')
    if cleaned in {"/dev/null", ""}:
        return ""
    if cleaned.startswith("a/") or cleaned.startswith("b/"):
        return cleaned[2:]
    return cleaned


def parse_unified_diff_stats(patch_text: str) -> dict:
    """Return deterministic size/shape metrics for a unified diff."""
    files: list[str] = []
    seen: set[str] = set()
    additions = 0
    deletions = 0
    hunks = 0
    new_files = 0
    deleted_files = 0
    current_old = ""
    current_new = ""

    def remember(path: str) -> None:
        normalized = _normalize(_patch_path(path))
        if normalized and normalized not in seen:
            seen.add(normalized)
            files.append(normalized)

    for raw_line in patch_text.splitlines():
        if raw_line.startswith("diff --git "):
            parts = raw_line.split()
            current_old = _patch_path(parts[2]) if len(parts) > 2 else ""
            current_new = _patch_path(parts[3]) if len(parts) > 3 else ""
            remember(current_new or current_old)
            continue
        if raw_line.startswith("new file mode"):
            new_files += 1
            continue
        if raw_line.startswith("deleted file mode"):
            deleted_files += 1
            continue
        if raw_line.startswith("--- "):
            current_old = _patch_path(raw_line[4:])
            if current_old:
                remember(current_old)
            continue
        if raw_line.startswith("+++ "):
            current_new = _patch_path(raw_line[4:])
            if current_new:
                remember(current_new)
            continue
        if raw_line.startswith("@@"):
            hunks += 1
            continue
        if raw_line.startswith("+") and not raw_line.startswith("+++"):
            additions += 1
            continue
        if raw_line.startswith("-") and not raw_line.startswith("---"):
            deletions += 1

    return asdict(
        DiffStats(
            files=files,
            files_changed=len(files),
            additions=additions,
            deletions=deletions,
            changed_lines=additions + deletions,
            hunks=hunks,
            new_files=new_files,
            deleted_files=deleted_files,
        )
    )


def _append_diff_quality_issues(issues: list[QualityIssue], diff_stats: dict | None) -> None:
    if not diff_stats:
        return
    changed_lines = int(diff_stats.get("changed_lines") or 0)
    additions = int(diff_stats.get("additions") or 0)
    hunks = int(diff_stats.get("hunks") or 0)
    files_changed = int(diff_stats.get("files_changed") or 0)
    new_files = int(diff_stats.get("new_files") or 0)

    if changed_lines > 500:
        issues.append(
            QualityIssue(
                "warning",
                "large-diff",
                f"Diff changes {changed_lines} lines; split or justify the scope before handoff.",
            )
        )
    if hunks > 30:
        issues.append(
            QualityIssue(
                "warning",
                "high-hunk-count",
                f"Diff spans {hunks} hunks; review for avoidable churn and focused edits.",
            )
        )
    if new_files > 8:
        issues.append(
            QualityIssue(
                "warning",
                "new-file-surge",
                f"Diff adds {new_files} files; confirm the new surface is necessary.",
            )
        )
    if files_changed and additions / max(files_changed, 1) > 180:
        issues.append(
            QualityIssue(
                "warning",
                "over-engineering-risk",
                "Average added lines per changed file is high; confirm this is the smallest useful design.",
            )
        )


def assess_changed_files(
    files: Iterable[str],
    *,
    resolver: Callable[[str], Path] | None = None,
    diff_stats: dict | None = None,
) -> dict:
    """Assess changed files against project quality standards."""
    changed = list(dict.fromkeys(str(item) for item in files if item))
    resolve = resolver or _default_resolver
    issues: list[QualityIssue] = []

    if not changed:
        return {"passed": True, "score": 100, "files_checked": 0, "issues": [], "summary": "no changed files"}

    if len(changed) > 20:
        issues.append(
            QualityIssue(
                "warning",
                "broad-change",
                f"{len(changed)} files changed; split or justify broad changes before handoff.",
            )
        )

    docs_touched = any(_is_doc(path) for path in changed)
    public_surface_changed = any(_touches_public_surface(path) and _is_code(path) for path in changed)
    if public_surface_changed and not docs_touched:
        issues.append(
            QualityIssue(
                "warning",
                "docs-sync",
                "Public CLI/Bridge/product surface changed without README/docs updates.",
            )
        )

    _append_diff_quality_issues(issues, diff_stats)

    checked = 0
    for filename in changed:
        normalized = _normalize(filename)
        if _looks_generated(normalized):
            issues.append(QualityIssue("warning", "generated-file", "Generated/cache/build output changed.", filename))
            continue
        try:
            target = resolve(filename)
        except Exception as exc:  # noqa: BLE001
            issues.append(QualityIssue("warning", "unresolved-path", f"Could not resolve changed path: {exc}", filename))
            continue
        if not target.exists() or not target.is_file():
            issues.append(QualityIssue("warning", "missing-file", "Changed file no longer exists.", filename))
            continue
        if not _is_code(filename) and not _is_doc(filename):
            continue
        text = _read_text(target)
        if text is None:
            issues.append(QualityIssue("warning", "binary-skip", "Binary or non-UTF-8 file skipped.", filename))
            continue
        checked += 1
        lines = text.splitlines()
        if len(lines) > 800:
            issues.append(
                QualityIssue("warning", "large-file", f"Changed file has {len(lines)} lines; consider narrower edits.", filename)
            )
        for idx, line in enumerate(lines, start=1):
            if line.rstrip() != line:
                issues.append(QualityIssue("error", "trailing-whitespace", f"Trailing whitespace at line {idx}.", filename))
                break
        if target.suffix == ".py":
            for idx, line in enumerate(lines, start=1):
                if line.startswith("\t"):
                    issues.append(QualityIssue("error", "tab-indent", f"Tab indentation at line {idx}.", filename))
                    break

    score = 100
    for issue in issues:
        score -= 25 if issue.level == "error" else 10
    score = max(score, 0)
    passed = all(issue.level != "error" for issue in issues) and score >= 70
    return {
        "passed": passed,
        "score": score,
        "files_checked": checked,
        "diff_stats": diff_stats or {
            "files": changed,
            "files_changed": len(changed),
            "additions": 0,
            "deletions": 0,
            "changed_lines": 0,
            "hunks": 0,
            "new_files": 0,
            "deleted_files": 0,
        },
        "issues": [asdict(issue) for issue in issues],
        "summary": f"{checked} files checked, {len(issues)} quality issues",
    }


def assess_quality_change(
    files: Iterable[str] | None = None,
    *,
    patch_text: str = "",
    root: Path | None = None,
    resolver: Callable[[str], Path] | None = None,
) -> dict:
    """Assess files plus optional unified diff metrics as one delivery gate."""
    diff_stats = parse_unified_diff_stats(patch_text) if patch_text else None
    changed = list(dict.fromkeys(str(item) for item in (files or []) if item))
    if diff_stats:
        changed = list(dict.fromkeys([*changed, *diff_stats.get("files", [])]))

    if resolver is None and root is not None:
        base = root.resolve()

        def resolver(filename: str) -> Path:
            return base / filename

    return assess_changed_files(changed, resolver=resolver, diff_stats=diff_stats)


def format_quality_report(report: dict) -> str:
    status = "PASS" if report.get("passed") else "REVIEW"
    lines = [
        f"G12 quality gate: {status} (score {report.get('score', 0)}/100)",
        f"  {report.get('summary', '')}",
    ]
    diff_stats = report.get("diff_stats") or {}
    if diff_stats:
        lines.append(
            "  Diff: "
            f"{diff_stats.get('files_changed', 0)} files, "
            f"+{diff_stats.get('additions', 0)}/-{diff_stats.get('deletions', 0)}, "
            f"{diff_stats.get('hunks', 0)} hunks"
        )
    for issue in report.get("issues", [])[:12]:
        target = f" {issue.get('file')}" if issue.get("file") else ""
        lines.append(f"  - [{issue.get('level')}] {issue.get('code')}:{target} {issue.get('message')}")
    if len(report.get("issues", [])) > 12:
        lines.append(f"  ... {len(report['issues']) - 12} more")
    return "\n".join(lines)
