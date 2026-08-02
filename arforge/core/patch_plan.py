"""Read-only planning for large or batched unified patches."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from arforge.security._diff_parser import ParsedHunk, hunk_to_text, parse_unified_diff
from arforge.security.diff_applicator import HunkResult, apply_patch
from arforge.security.file_ops import safe_write


def analyze_patch_plan(
    patch_text: str,
    *,
    root: str | Path = ".",
    max_hunks_per_batch: int = 5,
    large_file_lines: int = 800,
) -> dict[str, Any]:
    """Analyze a unified diff and propose safe review/apply batches."""
    if not patch_text or not patch_text.strip():
        raise ValueError("patch_text is required")

    base = Path(root).resolve()
    sections = _split_file_sections(patch_text)
    files: list[dict[str, Any]] = []
    total_hunks = 0
    total_additions = 0
    total_deletions = 0
    warnings: list[str] = []

    for section in sections:
        hunks = parse_unified_diff(section["text"])
        additions = _count_lines(hunks, "+")
        deletions = _count_lines(hunks, "-")
        total_hunks += len(hunks)
        total_additions += additions
        total_deletions += deletions
        path = section["new_path"] or section["old_path"] or "(unknown)"
        line_count = _line_count(base / path) if path != "(unknown)" else 0
        large_file = line_count >= large_file_lines if line_count else False
        batches = _build_batches(hunks, max_hunks_per_batch)
        files.append(
            {
                "path": path,
                "old_path": section["old_path"],
                "new_path": section["new_path"],
                "hunks": len(hunks),
                "additions": additions,
                "deletions": deletions,
                "line_count": line_count,
                "large_file": large_file,
                "batches": batches,
            }
        )
        if large_file:
            warnings.append(f"{path} has {line_count} lines; review/apply in small batches.")
        if len(hunks) > max_hunks_per_batch:
            warnings.append(f"{path} has {len(hunks)} hunks; split into {len(batches)} batches.")

    if len(files) > 10:
        warnings.append("Patch touches more than 10 files; prefer staged review by subsystem.")
    if total_hunks > 20:
        warnings.append("Patch contains more than 20 hunks; run targeted verification after each batch.")
    if not files or total_hunks == 0:
        warnings.append("No unified diff hunks were found; verify patch format before applying.")

    return {
        "files": files,
        "summary": {
            "files": len(files),
            "hunks": total_hunks,
            "additions": total_additions,
            "deletions": total_deletions,
            "batches": sum(len(file["batches"]) for file in files),
        },
        "warnings": warnings,
    }


def format_patch_plan(plan: dict[str, Any]) -> str:
    summary = plan["summary"]
    lines = [
        "Patch plan",
        f"- files: {summary['files']}",
        f"- hunks: {summary['hunks']}",
        f"- additions: {summary['additions']}",
        f"- deletions: {summary['deletions']}",
        f"- suggested_batches: {summary['batches']}",
    ]
    if plan["warnings"]:
        lines.append("")
        lines.append("Warnings:")
        lines.extend(f"- {warning}" for warning in plan["warnings"])
    if plan["files"]:
        lines.append("")
        lines.append("Files:")
        for file in plan["files"]:
            lines.append(
                f"- {file['path']}: hunks={file['hunks']} +{file['additions']} -{file['deletions']} "
                f"batches={len(file['batches'])}"
            )
    return "\n".join(lines)


def apply_patch_batch(
    patch_text: str,
    *,
    root: str | Path = ".",
    batch_index: int = 0,
    max_hunks_per_batch: int = 5,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Apply or preview one suggested hunk batch from a unified diff.

    The operation is atomic at file level: the target is written only if every
    hunk in the selected batch applies and syntax validation passes.
    """
    if batch_index < 0:
        raise ValueError("batch_index must be non-negative")

    base = Path(root).resolve()
    batches = list(_iter_global_batches(patch_text, max_hunks_per_batch=max_hunks_per_batch))
    if not batches:
        raise ValueError("no patch batches found")
    if batch_index >= len(batches):
        raise ValueError(f"batch_index must be between 0 and {len(batches) - 1}")

    batch = batches[batch_index]
    target = _resolve_under_root(base, batch["path"])
    original = target.read_text(encoding="utf-8-sig") if target.exists() else ""
    selected_patch = _render_selected_patch(batch)
    new_content, hunk_results = apply_patch(original, selected_patch, strict=False)
    applied = sum(1 for item in hunk_results if item.applied)
    failed = [item for item in hunk_results if not item.applied]
    if failed or applied != len(batch["hunks"]):
        return _batch_result(
            batch,
            batch_index=batch_index,
            dry_run=dry_run,
            success=False,
            applied=False,
            hunk_results=hunk_results,
            error="one or more hunks failed to apply",
        )

    ok, validation_error = _validate_content(target, new_content)
    if not ok:
        return _batch_result(
            batch,
            batch_index=batch_index,
            dry_run=dry_run,
            success=False,
            applied=False,
            hunk_results=hunk_results,
            error=validation_error,
        )

    backup_path = ""
    if not dry_run:
        result = safe_write(target, new_content, auto_backup=target.exists(), require_confirm=True)
        if not result.get("success"):
            return _batch_result(
                batch,
                batch_index=batch_index,
                dry_run=dry_run,
                success=False,
                applied=False,
                hunk_results=hunk_results,
                error=str(result.get("error", "atomic file write failed")),
            )
        backup_path = str(result.get("backup_path", ""))

    return _batch_result(
        batch,
        batch_index=batch_index,
        dry_run=dry_run,
        success=True,
        applied=not dry_run,
        hunk_results=hunk_results,
        backup_path=backup_path,
        new_content=new_content,
    )


def _split_file_sections(patch_text: str) -> list[dict[str, str]]:
    sections: list[dict[str, str]] = []
    current: list[str] = []
    old_path = ""
    new_path = ""

    for raw_line in patch_text.splitlines():
        line = raw_line.rstrip("\n\r")
        starts_new_file = line.startswith("diff --git ") or (
            line.startswith("--- ") and current and any(entry.startswith("@@ ") for entry in current)
        )
        if starts_new_file and current:
            sections.append({"old_path": old_path, "new_path": new_path, "text": "\n".join(current)})
            current = []
            old_path = ""
            new_path = ""
        current.append(line)
        if line.startswith("--- "):
            old_path = _clean_diff_path(line[4:].strip())
        elif line.startswith("+++ "):
            new_path = _clean_diff_path(line[4:].strip())

    if current:
        sections.append({"old_path": old_path, "new_path": new_path, "text": "\n".join(current)})
    return [section for section in sections if section["text"].strip()]


def _iter_global_batches(patch_text: str, *, max_hunks_per_batch: int):
    size = max(1, int(max_hunks_per_batch))
    for section in _split_file_sections(patch_text):
        path = section["new_path"] or section["old_path"]
        if not path:
            continue
        hunks = parse_unified_diff(section["text"])
        for start in range(0, len(hunks), size):
            selected = hunks[start : start + size]
            if selected:
                yield {
                    "path": path,
                    "old_path": section["old_path"],
                    "new_path": section["new_path"],
                    "first_hunk": start,
                    "last_hunk": start + len(selected) - 1,
                    "hunks": selected,
                }


def _render_selected_patch(batch: dict[str, Any]) -> str:
    lines = [
        f"--- a/{batch['path']}",
        f"+++ b/{batch['path']}",
    ]
    lines.extend(hunk_to_text(hunk) for hunk in batch["hunks"])
    return "\n".join(lines)


def _resolve_under_root(root: Path, rel_path: str) -> Path:
    candidate = Path(rel_path)
    if candidate.is_absolute():
        raise ValueError("absolute patch paths are not allowed")
    resolved = (root / candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("patch path escapes workspace")
    return resolved


def _validate_content(path: Path, content: str) -> tuple[bool, str]:
    if path.suffix.lower() not in {".py", ".pyi"}:
        return True, ""
    try:
        compile(content, str(path), "exec")
    except SyntaxError as exc:
        return False, f"Python syntax error at line {exc.lineno}: {exc.msg}"
    return True, ""


def _batch_result(
    batch: dict[str, Any],
    *,
    batch_index: int,
    dry_run: bool,
    success: bool,
    applied: bool,
    hunk_results: list[HunkResult],
    error: str = "",
    backup_path: str = "",
    new_content: str = "",
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "success": success,
        "applied": applied,
        "dry_run": dry_run,
        "batch_index": batch_index,
        "file": batch["path"],
        "first_hunk": batch["first_hunk"],
        "last_hunk": batch["last_hunk"],
        "hunks": len(batch["hunks"]),
        "hunks_applied": sum(1 for item in hunk_results if item.applied),
        "hunks_failed": sum(1 for item in hunk_results if not item.applied),
        "hunk_results": [
            {
                "hunk_index": item.hunk_index,
                "accepted": item.accepted,
                "applied": item.applied,
                "error": item.error,
                "offset_shift": item.offset_shift,
            }
            for item in hunk_results
        ],
        "backup_path": backup_path,
        "error": error,
        "preview": new_content[:2000] if dry_run and new_content else "",
    }


def _clean_diff_path(value: str) -> str:
    if value == "/dev/null":
        return ""
    if value.startswith("a/") or value.startswith("b/"):
        return value[2:]
    return value


def _count_lines(hunks: list[ParsedHunk], prefix: str) -> int:
    return sum(1 for hunk in hunks for line_prefix, _text in hunk.lines if line_prefix == prefix)


def _build_batches(hunks: list[ParsedHunk], max_hunks_per_batch: int) -> list[dict[str, int]]:
    size = max(1, int(max_hunks_per_batch))
    batches: list[dict[str, int]] = []
    for start in range(0, len(hunks), size):
        group = hunks[start : start + size]
        batches.append(
            {
                "first_hunk": start,
                "last_hunk": start + len(group) - 1,
                "hunks": len(group),
                "additions": _count_lines(group, "+"),
                "deletions": _count_lines(group, "-"),
            }
        )
    return batches


def _line_count(path: Path) -> int:
    try:
        return len(path.read_text(encoding="utf-8", errors="replace").splitlines())
    except OSError:
        return 0
