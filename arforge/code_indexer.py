"""Lightweight code file index with multi-language support."""

from __future__ import annotations

from pathlib import Path

from arforge.project_scanner import scan_project

_PY_SUFFIXES = (".py",)
_JS_SUFFIXES = (".js", ".jsx", ".mjs", ".cjs")
_TS_SUFFIXES = (".ts", ".tsx")
_GO_SUFFIXES = (".go",)
_RUST_SUFFIXES = (".rs",)
_ALL_SUFFIXES = _PY_SUFFIXES + _JS_SUFFIXES + _TS_SUFFIXES + _GO_SUFFIXES + _RUST_SUFFIXES

_INDEX: list[dict] = []


def index_project(root: str | Path = ".", suffixes: tuple[str, ...] = _ALL_SUFFIXES) -> dict:
    global _INDEX
    _INDEX = [
        item for item in scan_project(root, suffixes=suffixes)
        if "arforge_corrupt_backup" not in item["path"]
    ]
    return {"success": True, "files": len(_INDEX)}


def list_code_files(suffixes: tuple[str, ...] = _ALL_SUFFIXES) -> list[str]:
    if not _INDEX:
        index_project(suffixes=suffixes)
    return [
        item["path"] for item in _INDEX
        if Path(item["path"]).suffix.lower() in suffixes
    ]


def list_code_index(limit: int = 50):
    if not _INDEX:
        index_project()
    return _INDEX[:limit]


def search_code(
    keyword: str,
    root: str | Path = ".",
    limit: int = 20,
    suffixes: tuple[str, ...] = _ALL_SUFFIXES,
) -> list[dict]:
    """Search code text across all supported languages."""
    base = Path(root)
    matches = []
    for item in scan_project(base, suffixes=suffixes):
        path = base / item["path"]
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except (OSError, PermissionError):
            continue
        if keyword.lower() in text.lower():
            line_no = next(
                (i for i, line in enumerate(text.splitlines(), 1) if keyword.lower() in line.lower()),
                0,
            )
            matches.append({"path": item["path"], "line": line_no})
            if len(matches) >= limit:
                break
    return matches


def search_symbol_multi_lang(
    symbol_name: str,
    match_mode: str = "substring",
    limit: int = 30,
) -> list[dict]:
    """Search symbols across Python AST and multi-language tree-sitter index.

    Falls back to Python-only AST if tree-sitter is not available.
    """
    results: list[dict] = []

    # Python AST symbols
    try:
        from arforge.python_ast_indexer import search_symbol as py_search
        results.extend(py_search(symbol_name, match_mode=match_mode))
    except Exception:
        pass

    # Multi-language tree-sitter symbols
    try:
        from arforge.multi_lang_indexer import search_multi_lang_symbol
        results.extend(search_multi_lang_symbol(symbol_name, match_mode=match_mode))
    except Exception:
        pass

    # Deduplicate by file+line
    seen = set()
    unique = []
    for r in results:
        key = (r["file"], r.get("line", 0), r.get("name", ""))
        if key not in seen:
            seen.add(key)
            unique.append(r)

    return unique[:limit]


def show_code_index_status() -> str:
    """Show code index status including multi-language support."""
    if not _INDEX:
        index_project()

    by_suffix: dict[str, int] = {}
    for item in _INDEX:
        suffix = Path(item["path"]).suffix.lower()
        by_suffix[suffix] = by_suffix.get(suffix, 0) + 1

    lines = [f"Indexed files: {len(_INDEX)}"]
    for suffix, count in sorted(by_suffix.items()):
        lines.append(f"  {suffix}: {count} files")

    # Multi-language symbol status
    try:
        from arforge.multi_lang_indexer import get_index_status
        status = get_index_status()
        if status["indexed"]:
            lines.append(f"Tree-sitter symbols: {status['total']}")
            for lang, cnt in status.get("counts", {}).items():
                lines.append(f"  {lang}: {cnt} symbols")
        else:
            lines.append(f"Tree-sitter available: {', '.join(status['languages'])}")
    except Exception:
        lines.append("Tree-sitter: not available")

    return "\n".join(lines)
