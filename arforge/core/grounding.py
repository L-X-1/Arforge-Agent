"""Evidence/grounding enforcement for LLM answers (3.1).

When an agentic answer references files (read, written, or searched),
it must include <evidence> tags citing the specific tool results that
support its claims. This is the primary hallucination-reduction mechanism.

Usage in agentic.py final-answer gate:
    from arforge.core.grounding import has_evidence_tag, validate_evidence
    if has_file_references(answer, tool_calls_log) and not has_evidence_tag(answer):
        inject "please add <evidence> citations" feedback (max 1 retry)
"""

from __future__ import annotations

import re
from typing import Any

# Regex to detect <evidence>...</evidence> or <evidence ... /> tags
_EVIDENCE_RE = re.compile(r"<evidence[^>]*>.*?</evidence>", re.DOTALL | re.IGNORECASE)
_EVIDENCE_SELF_CLOSING_RE = re.compile(r"<evidence\s+[^>]*/>", re.IGNORECASE)

# File-related tool names — answers referencing files from these tools need evidence
FILE_TOOLS = {
    "read_file", "code_read", "list_files", "list_code_files",
    "code_search", "search_code", "grep", "find_files",
}

WRITE_TOOLS_EVIDENCE = {
    "write_file", "edit_file", "create_file", "delete_file",
    "apply_patch_batch", "apply_patch",
}

# Patterns that suggest file references in the answer.  Restrict extensions to
# real project/document formats: the previous generic ``.word`` matcher treated
# IP addresses and DOM selectors such as ``div.wk-block`` as source files.
_FILE_EXTENSIONS = (
    "py|pyi|js|jsx|mjs|cjs|ts|tsx|java|kt|kts|go|rs|c|cc|cpp|cxx|h|hpp|"
    "cs|rb|php|swift|scala|sh|bash|ps1|bat|cmd|sql|html|htm|css|scss|sass|"
    "less|vue|svelte|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|md|mdx|rst|"
    "txt|csv|tsv|log|pdf|docx?|xlsx?|pptx?|lock"
)
_WEB_URL_RE = re.compile(r"\bhttps?://[^\s<>'\"]+", re.IGNORECASE)
_FILE_REF_PATTERNS = [
    re.compile(rf"(?<![\w.])([\w.-]+(?:[/\\][\w.-]+)*\.(?:{_FILE_EXTENSIONS}))(?![\w.-])", re.IGNORECASE),
    re.compile(rf"(?:file|path|module)\s*[:=]?\s*[`'\"]?([\w./\\-]+\.(?:{_FILE_EXTENSIONS}))(?![\w.-])", re.IGNORECASE),
    re.compile(rf"(?:in|from|at)\s+[`'\"]?([\w./\\-]+\.(?:{_FILE_EXTENSIONS}))(?![\w.-])", re.IGNORECASE),
    re.compile(r"```\w*\n", re.IGNORECASE),  # code block suggests code was read/written
]


def _without_web_urls(text: str) -> str:
    return _WEB_URL_RE.sub(" ", str(text or ""))


def has_evidence_tag(text: str) -> bool:
    """Return True if *text* contains at least one <evidence> tag.

    Accepts both wrapping tags (<evidence>...</evidence>) and
    self-closing tags (<evidence file="..." line="..." />).
    """
    if not text or not text.strip():
        return False
    return bool(_EVIDENCE_RE.search(text)) or bool(_EVIDENCE_SELF_CLOSING_RE.search(text))


def has_file_references(answer: str, tool_calls_log: list[dict[str, Any]]) -> bool:
    """Return True if the answer likely references files that need evidence.

    Checks two signals:
    1. The answer text contains file-path patterns
    2. The tool log shows file-related tools were used
    """
    # Signal 1: answer text patterns
    answer_without_urls = _without_web_urls(answer)
    for pattern in _FILE_REF_PATTERNS:
        if pattern.search(answer_without_urls):
            return True

    # Signal 2: file tools were used during this run
    for entry in tool_calls_log:
        tool = str(entry.get("tool", "") or "")
        if tool in FILE_TOOLS or tool in WRITE_TOOLS_EVIDENCE:
            return True

    return False


def answer_has_file_claims(answer: str) -> bool:
    """Return whether the answer itself makes a concrete file/code claim.

    Merely reading a file during a turn must not force a generic answer such as
    ``done`` to emit an XML citation.  The tool log is evidence context, not a
    claim made by the final answer.
    """
    cleaned = _without_web_urls(answer)
    return any(pattern.search(cleaned) for pattern in _FILE_REF_PATTERNS)


def get_modified_files(tool_calls_log: list[dict[str, Any]]) -> list[str]:
    """Extract the list of modified file paths from the tool log."""
    modified = []
    for entry in tool_calls_log:
        tool = str(entry.get("tool", "") or "")
        if tool in WRITE_TOOLS_EVIDENCE and entry.get("success"):
            args = entry.get("args", {}) or {}
            filename = args.get("filename") or args.get("path") or args.get("file") or ""
            if filename:
                modified.append(filename)
    return modified


def get_read_files(tool_calls_log: list[dict[str, Any]]) -> list[str]:
    """Extract the list of files read during this run."""
    read = []
    for entry in tool_calls_log:
        tool = str(entry.get("tool", "") or "")
        if tool in FILE_TOOLS and entry.get("success"):
            args = entry.get("args", {}) or {}
            filename = args.get("filename") or args.get("path") or args.get("file") or ""
            if filename:
                read.append(filename)
    return read


def validate_evidence(
    answer: str,
    tool_calls_log: list[dict[str, Any]],
) -> dict[str, Any]:
    """Validate that the answer has evidence when it should.

    Returns:
        {"valid": bool, "needs_evidence": bool, "missing_citations": [str, ...]}
    """
    if not answer or not answer.strip():
        return {"valid": True, "needs_evidence": False, "missing_citations": []}

    has_tag = has_evidence_tag(answer)
    needs = has_tag or answer_has_file_claims(answer)

    if needs and not has_tag:
        return {
            "valid": False,
            "needs_evidence": True,
            "missing_citations": get_modified_files(tool_calls_log)[:5],
        }

    return {"valid": True, "needs_evidence": needs, "missing_citations": []}


def build_evidence_feedback(missing_files: list[str]) -> str:
    """Build a feedback message requesting evidence tags.

    Injects into the conversation as a user message before the next LLM call.
    """
    files_str = "\n".join(f"  - {f}" for f in missing_files[:5])
    return (
        "\n[Grounding] Your answer discusses code or files but does not include "
        "<evidence> tags. Please add evidence citations for the files you worked "
        "with. Use the format:\n\n"
        '<evidence file="path/to/file.py" line="42">what you found</evidence>\n\n'
        f"Files that need citations:\n{files_str}\n"
    )
