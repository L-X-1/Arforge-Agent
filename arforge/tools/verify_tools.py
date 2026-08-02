"""Delivery quality gate tools.

``verify_work`` validates files changed during the current run.  G10 covers
syntax/format checks, while G12 adds lightweight quality standards: narrow
changes, documentation sync for public surfaces, generated-file avoidance and
basic style hygiene.
"""

from __future__ import annotations

from arforge.core.change_tracker import get_change_tracker
from arforge.core.edit_verify import verify_path
from arforge.core.quality_gate import assess_changed_files, format_quality_report
from arforge.tool_registry import register_tool


@register_tool(
    "verify_work",
    "Delivery gate: validate every file changed in this task and report syntax, "
    "format and G12 quality issues before final handoff.",
    params=[],
    priority=88,
    risk="low",
    category="read",
    source=__name__,
)
def verify_work() -> str:
    files = get_change_tracker().changed()
    if not files:
        return "Delivery quality gate: no changed files, nothing to verify."

    from arforge.tools.file_tools import _resolve

    problems: list[str] = []
    deleted: list[str] = []
    existing_files: list[str] = []
    checked = 0
    for filename in files:
        try:
            target = _resolve(filename)
        except Exception:
            continue
        if not target.exists():
            deleted.append(filename)
            continue
        existing_files.append(filename)
        checked += 1
        ok, message = verify_path(target)
        if not ok:
            problems.append(f"  - {filename}: {message}")

    quality_report = assess_changed_files(existing_files)
    report_lines = [
        f"Delivery quality gate: {len(files)} changed files, {checked} syntax/format checks.",
        "Changed files: " + ", ".join(files),
    ]
    if deleted:
        report_lines.append("Deleted files: " + ", ".join(deleted))
    report_lines.append(format_quality_report(quality_report))
    report = "\n".join(report_lines)
    if problems:
        return report + "\nSyntax/format problems, fix before final handoff:\n" + "\n".join(problems)
    return report + "\nAll syntax/format checks passed."
