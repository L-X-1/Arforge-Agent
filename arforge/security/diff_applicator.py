"""Apply and preview file modifications."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Set, Tuple

from arforge.security._diff_parser import ParsedHunk, parse_unified_diff as _parse_unified_diff
from arforge.security.backup_manager import backup_file, search_by_original
from arforge.security.diff_generator import (
    DiffHunk,
    DiffResult,
    diff_summary_cn,
    format_diff_for_terminal as _format_diff_for_terminal,
    generate_unified_diff,
)
from arforge.security.file_ops import safe_write


@dataclass
class HunkResult:
    hunk_index: int
    accepted: bool
    applied: bool
    error: str = ""
    offset_shift: int = 0


@dataclass
class ApplyResult:
    file_path: Path
    success: bool
    original_content: str
    new_content: str = ""
    hunks_total: int = 0
    hunks_accepted: int = 0
    hunks_applied: int = 0
    hunks_rejected: int = 0
    hunks_failed: int = 0
    hunk_results: List[HunkResult] = field(default_factory=list)
    backup_path: str = ""
    error: str = ""


@dataclass
class MultiApplyResult:
    results: List[ApplyResult] = field(default_factory=list)


def check_operation(operation_type: str, description: str = "", operation_key: str = "", **context) -> dict:
    return {"allowed": True, "operation_type": operation_type, "description": description, "operation_key": operation_key, "context": context}


def format_diff_for_terminal(unified_diff_text: str) -> str:
    return _format_diff_for_terminal(unified_diff_text)


def preview_only(file_path: Path, new_content: str) -> DiffResult:
    path = Path(file_path)
    original = path.read_text(encoding="utf-8") if path.exists() else ""
    return generate_unified_diff(path, original, new_content)


def preview_diff_interactive(diff_result: DiffResult, auto_accept: bool = False) -> Set[int]:
    if auto_accept:
        return set(range(len(diff_result.hunks)))
    return set()


def preview_summary_only(changes: List[Tuple[Path, str]]) -> str:
    diffs = [preview_only(path, content) for path, content in changes]
    return diff_summary_cn(diffs)


def apply_diff_direct(file_path: Path, new_content: str) -> ApplyResult:
    path = Path(file_path)
    original = path.read_text(encoding="utf-8") if path.exists() else ""
    backup = backup_file(path) if path.exists() else None
    result = safe_write(path, new_content, auto_backup=False, require_confirm=False)
    success = bool(result.get("success"))
    diff = generate_unified_diff(path, original, new_content)
    return ApplyResult(
        file_path=path,
        success=success,
        original_content=original,
        new_content=new_content if success else "",
        hunks_total=len(diff.hunks),
        hunks_accepted=len(diff.hunks),
        hunks_applied=len(diff.hunks) if success else 0,
        hunks_failed=0 if success else len(diff.hunks),
        backup_path=str(backup) if backup else "",
        error=result.get("error", ""),
    )


def confirm_and_apply_to_file(
    file_path: Path,
    new_content: str,
    auto_accept: bool = False,
    require_confirm: bool = True,
) -> ApplyResult:
    if require_confirm and not auto_accept:
        return ApplyResult(Path(file_path), False, Path(file_path).read_text(encoding="utf-8") if Path(file_path).exists() else "", error="not confirmed")
    return apply_diff_direct(file_path, new_content)


def confirm_and_apply_multi(
    changes: List[Tuple[Path, str]],
    auto_accept: bool = False,
    require_confirm: bool = True,
) -> MultiApplyResult:
    return MultiApplyResult([confirm_and_apply_to_file(path, content, auto_accept, require_confirm) for path, content in changes])


def apply_patch(original_content: str, unified_diff: str, strict: bool = True) -> Tuple[str, List[HunkResult]]:
    """Apply a unified diff patch to original content.

    In strict mode, context lines must match exactly at the expected position.
    In non-strict mode, a ±3 line offset search is attempted before failing.

    Returns (new_content, hunk_results).
    """
    hunks = _parse_unified_diff(unified_diff)
    if not hunks:
        return original_content, [HunkResult(0, False, False, "no hunks found in diff")]

    lines = original_content.splitlines(keepends=True)
    # Handle empty original
    if not lines and original_content:
        lines = [""]
    if not original_content and not lines:
        lines = []

    results: list[HunkResult] = []
    # Apply hunks from last to first to preserve line positions
    for hunk_idx in range(len(hunks) - 1, -1, -1):
        hunk = hunks[hunk_idx]
        result = _apply_single_hunk(lines, hunk, hunk_idx, strict)
        results.insert(0, result)
        if not result.applied:
            # On failure, stop applying remaining hunks
            break

    new_content = "".join(lines)
    return new_content, results


def _apply_single_hunk(
    lines: list[str],
    hunk: "ParsedHunk",
    hunk_index: int,
    strict: bool,
) -> HunkResult:
    """Apply a single parsed hunk to a mutable list of lines.

    lines is mutated in-place.
    """
    # Anchor position (0-indexed)
    anchor = hunk.old_start - 1
    if anchor < 0:
        anchor = 0

    # Old lines = context (' ') + deletions ('-') — must exist in original
    old_lines = [(p, t) for p, t in hunk.lines if p in (" ", "-")]
    # New lines = context (' ') + additions ('+') — written to result
    new_lines = [t for p, t in hunk.lines if p in (" ", "+")]

    # Find actual position by matching old lines
    pos = _find_hunk_position(lines, anchor, old_lines, strict)
    if pos == -1:
        return HunkResult(hunk_index, False, False, f"context mismatch at line {hunk.old_start}", offset_shift=0)

    # Calculate old section size
    old_count = hunk.old_count
    if pos + old_count > len(lines):
        old_count = len(lines) - pos

    # Replace: remove old lines, insert new lines
    formatted_new = [ln + ("\n" if not ln.endswith("\n") else "") for ln in new_lines]
    lines[pos : pos + old_count] = formatted_new

    offset_shift = pos - anchor
    return HunkResult(hunk_index, True, True, offset_shift=offset_shift)


def _find_hunk_position(
    lines: list[str],
    anchor: int,
    old_lines: list[tuple[str, str]],
    strict: bool,
) -> int:
    """Find the best position for a hunk by matching old lines (context + deletions).

    Returns the 0-indexed position, or -1 if no match found.
    """
    if not old_lines:
        # No old lines — use anchor directly
        if 0 <= anchor <= len(lines):
            return anchor
        return -1

    # Clamp to valid range
    anchor = max(0, min(anchor, len(lines)))

    # Strict: exact match at anchor
    if _old_lines_match(lines, anchor, old_lines):
        return anchor
    if strict:
        return -1

    # Non-strict: search ±3 lines
    search_range = 3
    for offset in range(1, search_range + 1):
        for candidate in (anchor + offset, anchor - offset):
            if 0 <= candidate <= len(lines):
                if _old_lines_match(lines, candidate, old_lines):
                    return candidate

    return -1


def _old_lines_match(lines: list[str], pos: int, old_lines: list[tuple[str, str]]) -> bool:
    """Check if old_lines (context + deletions from hunk) match original lines at pos."""
    if pos < 0 or pos > len(lines):
        return False
    for i, (_prefix, text) in enumerate(old_lines):
        line_pos = pos + i
        if line_pos >= len(lines):
            return False
        if lines[line_pos].rstrip("\n\r") != text.rstrip("\n\r"):
            return False
    return True


def apply_patch_with_selection(
    original_content: str, unified_diff: str, accepted_hunk_indices: Set[int]
) -> Tuple[str, List[HunkResult]]:
    """Apply only selected hunks from a unified diff.

    Hunks whose indices are NOT in accepted_hunk_indices are skipped.
    """
    hunks = _parse_unified_diff(unified_diff)
    if not hunks:
        return original_content, [HunkResult(0, False, False, "no hunks found in diff")]

    lines = original_content.splitlines(keepends=True)
    if not lines and original_content:
        lines = [""]
    if not original_content and not lines:
        lines = []

    results: list[HunkResult] = []
    for hunk_idx in range(len(hunks) - 1, -1, -1):
        hunk = hunks[hunk_idx]
        if hunk_idx not in accepted_hunk_indices:
            results.insert(
                0,
                HunkResult(hunk_idx, False, False, "hunk not accepted", offset_shift=0),
            )
            continue
        result = _apply_single_hunk(lines, hunk, hunk_idx, strict=False)
        results.insert(0, result)
        if not result.applied:
            break

    new_content = "".join(lines)
    return new_content, results


def apply_patch_text_direct(file_path: Path, patch_text: str) -> ApplyResult:
    """Read a file, apply a patch, and write the result back.

    Uses safe_write for atomic write with backup.
    """
    path = Path(file_path)
    original = path.read_text(encoding="utf-8") if path.exists() else ""

    new_content, hunk_results = apply_patch(original, patch_text, strict=False)

    if not any(r.applied for r in hunk_results):
        return ApplyResult(
            path,
            False,
            original,
            hunks_total=len(hunk_results),
            hunk_results=hunk_results,
            error="no hunks applied",
        )

    # Write the new content
    result = safe_write(path, new_content, auto_backup=True, require_confirm=False)
    success = bool(result.get("success"))

    return ApplyResult(
        file_path=path,
        success=success,
        original_content=original,
        new_content=new_content if success else "",
        hunks_total=len(hunk_results),
        hunks_accepted=sum(1 for r in hunk_results if r.accepted),
        hunks_applied=sum(1 for r in hunk_results if r.applied),
        hunks_rejected=sum(1 for r in hunk_results if not r.accepted),
        hunks_failed=sum(1 for r in hunk_results if r.accepted and not r.applied),
        hunk_results=hunk_results,
        backup_path=result.get("backup_path", ""),
        error=result.get("error", ""),
    )


def reverse_hunk(hunk: DiffHunk) -> DiffHunk:
    reversed_lines = []
    for line in hunk.lines:
        if line.startswith("+"):
            reversed_lines.append("-" + line[1:])
        elif line.startswith("-"):
            reversed_lines.append("+" + line[1:])
        else:
            reversed_lines.append(line)
    return DiffHunk(hunk.new_start, hunk.new_count, hunk.old_start, hunk.old_count, hunk.header, reversed_lines)


def generate_reverse_diff(diff_result: DiffResult) -> str:
    reverse = generate_unified_diff(diff_result.file_path, diff_result.new_content, diff_result.original_content)
    return reverse.unified_diff


def rollback_last_change(file_path: Path) -> dict:
    path = Path(file_path)
    matches = search_by_original(path, limit=1)
    if not matches:
        return {"success": False, "error": "no backup found"}
    backup_path = Path(matches[0]["backup_path"])
    if not backup_path.exists():
        return {"success": False, "error": "backup file missing"}
    result = safe_write(path, backup_path.read_text(encoding="utf-8"), auto_backup=True, require_confirm=False)
    return {"success": bool(result.get("success")), "backup_path": str(backup_path), "error": result.get("error", "")}
