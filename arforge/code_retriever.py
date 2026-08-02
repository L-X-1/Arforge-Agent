"""Retrieve code snippets."""

from __future__ import annotations

from pathlib import Path

from arforge.code_indexer import search_code


def build_retrieved_context(keyword: str, top_k: int = 5):
    snippets = []
    for match in search_code(keyword, limit=top_k):
        path = Path(match["path"])
        if not path.exists():
            continue
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        idx = max(match["line"] - 1, 0)
        start = max(0, idx - 2)
        end = min(len(lines), idx + 3)
        snippets.append({"path": match["path"], "line": match["line"], "text": "\n".join(lines[start:end])})
    return snippets


def explain_retrieval(keyword: str):
    return f"Retrieved snippets matching keyword: {keyword}"
