"""Unified diff generation utilities."""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Tuple


@dataclass
class DiffStats:
    file_path: str = ""
    old_lines: int = 0
    new_lines: int = 0
    additions: int = 0
    deletions: int = 0
    hunk_count: int = 0
    changed_files: int = 0


@dataclass
class DiffHunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    header: str = ""
    lines: List[str] = field(default_factory=list)


@dataclass
class DiffResult:
    file_path: Path
    original_content: str
    new_content: str
    unified_diff: str
    hunks: List[DiffHunk] = field(default_factory=list)
    stats: DiffStats = field(default_factory=DiffStats)
    is_binary: bool = False
    has_changes: bool = True


@dataclass
class MultiDiffResult:
    results: List[DiffResult] = field(default_factory=list)
    total_stats: DiffStats = field(default_factory=DiffStats)


def is_binary_content(content: str, sample_size: int = 1024) -> bool:
    return "\0" in content[:sample_size]


def _split_lines(content: str) -> list[str]:
    return content.splitlines(keepends=True)


def diff_stats_from_patch(patch_text: str) -> DiffStats:
    stats = DiffStats()
    for line in patch_text.splitlines():
        if line.startswith("@@"):
            stats.hunk_count += 1
        elif line.startswith("+") and not line.startswith("+++"):
            stats.additions += 1
        elif line.startswith("-") and not line.startswith("---"):
            stats.deletions += 1
    stats.changed_files = 1 if stats.additions or stats.deletions else 0
    return stats


def _parse_hunks(patch_text: str) -> list[DiffHunk]:
    hunks: list[DiffHunk] = []
    current: DiffHunk | None = None
    for line in patch_text.splitlines():
        if line.startswith("@@"):
            header = line
            parts = line.split()
            old = parts[1][1:]
            new = parts[2][1:]
            old_start, old_count = _parse_range(old)
            new_start, new_count = _parse_range(new)
            current = DiffHunk(old_start, old_count, new_start, new_count, header, [])
            hunks.append(current)
        elif current is not None:
            current.lines.append(line)
    return hunks


def _parse_range(value: str) -> tuple[int, int]:
    if "," not in value:
        return int(value), 1
    start, count = value.split(",", 1)
    return int(start), int(count)


def generate_unified_diff(
    file_path: Path,
    original_content: str,
    new_content: str,
    context_lines: int = 3,
    source_label: str = "a",
    target_label: str = "b",
) -> DiffResult:
    path = Path(file_path)
    is_binary = is_binary_content(original_content) or is_binary_content(new_content)
    if is_binary:
        return DiffResult(path, original_content, new_content, "", [], DiffStats(str(path)), True, original_content != new_content)

    diff_lines = list(
        difflib.unified_diff(
            _split_lines(original_content),
            _split_lines(new_content),
            fromfile=f"{source_label}/{path.as_posix()}",
            tofile=f"{target_label}/{path.as_posix()}",
            n=context_lines,
            lineterm="",
        )
    )
    unified_diff = "\n".join(line.rstrip("\n") for line in diff_lines)
    stats = diff_stats_from_patch(unified_diff)
    stats.file_path = str(path)
    stats.old_lines = len(original_content.splitlines())
    stats.new_lines = len(new_content.splitlines())
    hunks = _parse_hunks(unified_diff)
    stats.hunk_count = len(hunks)
    return DiffResult(path, original_content, new_content, unified_diff, hunks, stats, False, original_content != new_content)


def diff_against_disk(file_path: Path, new_content: str, context_lines: int = 3) -> DiffResult:
    path = Path(file_path)
    original = path.read_text(encoding="utf-8") if path.exists() else ""
    return generate_unified_diff(path, original, new_content, context_lines)


def diff_files(original_path: Path, new_path: Path, context_lines: int = 3) -> DiffResult:
    old_path = Path(original_path)
    new_file = Path(new_path)
    old = old_path.read_text(encoding="utf-8")
    new = new_file.read_text(encoding="utf-8")
    return generate_unified_diff(old_path, old, new, context_lines)


def generate_multi_diff(changes: List[Tuple[Path, str, str]], context_lines: int = 3) -> MultiDiffResult:
    results = [generate_unified_diff(path, old, new, context_lines) for path, old, new in changes]
    total = DiffStats()
    for result in results:
        total.old_lines += result.stats.old_lines
        total.new_lines += result.stats.new_lines
        total.additions += result.stats.additions
        total.deletions += result.stats.deletions
        total.hunk_count += result.stats.hunk_count
        total.changed_files += 1 if result.has_changes else 0
    return MultiDiffResult(results, total)


def format_diff_for_terminal(unified_diff_text: str) -> str:
    return unified_diff_text


def diff_summary_cn(diff_results: List[DiffResult], max_files_in_detail: int = 10) -> str:
    total_add = sum(item.stats.additions for item in diff_results)
    total_del = sum(item.stats.deletions for item in diff_results)
    lines = [f"变更文件: {len(diff_results)}, 新增: {total_add}, 删除: {total_del}"]
    for item in diff_results[:max_files_in_detail]:
        lines.append(f"- {item.file_path}: +{item.stats.additions} -{item.stats.deletions}")
    return "\n".join(lines)
