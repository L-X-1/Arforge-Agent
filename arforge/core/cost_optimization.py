"""Advisory context-cost optimization from process-local file observations."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from arforge.core.file_state import get_file_state_tracker, snapshot_file


def build_cost_optimization_report(*, limit: int = 100) -> dict[str, Any]:
    """Return repeated-read and stale-file opportunities without caching content."""
    items: list[dict[str, Any]] = []
    observed_bytes = 0
    repeated_files = 0
    stale_files = 0
    missing_files = 0
    avoidable_reread_bytes = 0

    for observed in get_file_state_tracker().list()[:limit]:
        current = None
        missing = False
        changed = False
        try:
            current_snapshot = snapshot_file(Path(observed.path))
            current = current_snapshot.to_dict()
            changed = current_snapshot.sha256 != observed.sha256
        except OSError:
            missing = True
            changed = True

        repeated_reads = max(0, observed.read_count - 1)
        avoidable_bytes = 0 if changed else observed.size_bytes * repeated_reads
        if repeated_reads:
            repeated_files += 1
        if missing:
            missing_files += 1
        elif changed:
            stale_files += 1

        observed_bytes += observed.size_bytes
        avoidable_reread_bytes += avoidable_bytes
        items.append(
            {
                "path": observed.path,
                "read_count": observed.read_count,
                "repeated_reads": repeated_reads,
                "size_bytes": observed.size_bytes,
                "avoidable_reread_bytes": avoidable_bytes,
                "changed_since_observed": changed,
                "missing": missing,
                "observed": observed.to_dict(),
                "current": current,
            }
        )

    return {
        "schema_version": 1,
        "observed_files": len(items),
        "repeated_files": repeated_files,
        "stale_files": stale_files,
        "missing_files": missing_files,
        "observed_bytes": observed_bytes,
        "avoidable_reread_bytes": avoidable_reread_bytes,
        "estimated_avoidable_chars": avoidable_reread_bytes,
        "recommendations": _recommendations(
            observed_files=len(items),
            avoidable_reread_bytes=avoidable_reread_bytes,
            stale_files=stale_files,
            missing_files=missing_files,
        ),
        "items": sorted(
            items,
            key=lambda item: (
                -int(item["avoidable_reread_bytes"]),
                -int(item["read_count"]),
                str(item["path"]),
            ),
        ),
    }


def _recommendations(
    *,
    observed_files: int,
    avoidable_reread_bytes: int,
    stale_files: int,
    missing_files: int,
) -> list[str]:
    recommendations: list[str] = []
    if avoidable_reread_bytes > 0:
        recommendations.append("Use read_file_if_changed with observed SHA values before re-reading unchanged files.")
    if stale_files > 0:
        recommendations.append("Re-read changed files before editing or summarizing them.")
    if missing_files > 0:
        recommendations.append("Remove missing files from the active context before planning edits.")
    if observed_files == 0:
        recommendations.append("No file observations in this process yet; read files through Arforge tools to enable optimization.")
    if not recommendations:
        recommendations.append("No avoidable repeated-read cost detected in the current process.")
    return recommendations


def format_cost_optimization_report(report: dict[str, Any]) -> str:
    """Render a compact, deterministic CLI body."""
    lines = [
        f"Observed files: {report.get('observed_files', 0)}",
        f"Repeated files: {report.get('repeated_files', 0)}",
        f"Stale files: {report.get('stale_files', 0)}",
        f"Missing files: {report.get('missing_files', 0)}",
        f"Avoidable reread bytes: {report.get('avoidable_reread_bytes', 0)}",
    ]
    recommendations = report.get("recommendations") or []
    if recommendations:
        lines.append("Recommendations:")
        lines.extend(f"- {item}" for item in recommendations)
    return "\n".join(lines)
