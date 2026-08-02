"""Code summarization helpers."""

from __future__ import annotations

from pathlib import Path

from arforge.python_ast_indexer import list_file_symbols


def summarize_code_file(file_path: str) -> str:
    path = Path(file_path)
    if not path.exists():
        path = Path.cwd() / file_path
    if not path.exists():
        return "File not found."
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    symbols = list_file_symbols(str(path.relative_to(Path.cwd())) if path.is_absolute() and Path.cwd() in path.parents else file_path)
    return f"{file_path}: {len(lines)} lines, {len(symbols)} symbols"


def generate_all_module_summaries():
    return [summarize_code_file(str(path)) for path in Path("arforge").rglob("*.py")]


def list_module_summaries(limit: int = 50):
    return generate_all_module_summaries()[:limit]


def search_module_summaries(keyword: str, limit: int = 20):
    return [item for item in generate_all_module_summaries() if keyword.lower() in item.lower()][:limit]
