"""Unified diff parser — parse unified diff text into structured hunks.

Parses standard unified diff format produced by `diff -u`, `git diff`, and
Python's `difflib.unified_diff`.  Each hunk is represented as a ParsedHunk
with line-by-line prefix classification.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# @@ -old_start,old_count +new_start,new_count @@ optional header
_HUNK_HEADER_RE = re.compile(
    r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(.*)$"
)


@dataclass
class ParsedHunk:
    """A single parsed hunk from a unified diff."""

    old_start: int
    old_count: int
    new_start: int
    new_count: int
    header: str = ""
    lines: list[tuple[str, str]] = field(default_factory=list)
    # Each tuple is (prefix, text) where prefix is '+', '-', or ' '


def parse_unified_diff(diff_text: str) -> list[ParsedHunk]:
    """Parse unified diff text into a list of ParsedHunk objects.

    Handles standard unified diff format:
      @@ -old_start,old_count +new_start,new_count @@
       context line
      +added line
      -removed line
      ...

    Returns empty list for empty or unparseable diff text.
    """
    if not diff_text or not diff_text.strip():
        return []

    hunks: list[ParsedHunk] = []
    current_hunk: ParsedHunk | None = None
    pending_context: list[tuple[str, str]] = []

    for raw_line in diff_text.splitlines():
        line = raw_line.rstrip("\n\r")

        # Try to match hunk header
        m = _HUNK_HEADER_RE.match(line)
        if m:
            # Finalize previous hunk
            if current_hunk is not None:
                current_hunk.lines = pending_context.copy()
                hunks.append(current_hunk)

            old_start = int(m.group(1))
            old_count = int(m.group(2)) if m.group(2) else 1
            new_start = int(m.group(3))
            new_count = int(m.group(4)) if m.group(4) else 1
            header = m.group(5).strip()

            current_hunk = ParsedHunk(
                old_start=old_start,
                old_count=old_count,
                new_start=new_start,
                new_count=new_count,
                header=header,
            )
            pending_context = []
            continue

        # Skip file headers and non-hunk lines before first hunk
        if current_hunk is None:
            continue

        # Classify line by prefix
        if line.startswith(" "):
            pending_context.append((" ", line[1:]))
        elif line.startswith("+"):
            pending_context.append(("+", line[1:]))
        elif line.startswith("-"):
            pending_context.append(("-", line[1:]))
        elif line.startswith("\\"):  # "\ No newline at end of file"
            # Attach no-newline marker to the previous line's text
            if pending_context:
                prev_prefix, prev_text = pending_context[-1]
                pending_context[-1] = (prev_prefix, prev_text + "\n" + line)
        # Lines with other prefixes are skipped (e.g., diff metadata)

    # Finalize last hunk
    if current_hunk is not None:
        current_hunk.lines = pending_context
        hunks.append(current_hunk)

    return hunks


def hunk_to_text(hunk: ParsedHunk) -> str:
    """Convert a ParsedHunk back to unified diff text."""
    lines = [f"@@ -{hunk.old_start},{hunk.old_count} +{hunk.new_start},{hunk.new_count} @@"]
    if hunk.header:
        lines[-1] += " " + hunk.header
    for prefix, text in hunk.lines:
        # Handle multi-line text (no-newline markers)
        for part in text.split("\n"):
            lines.append(prefix + part)
    return "\n".join(lines)
