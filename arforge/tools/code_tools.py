"""Code intelligence tools — registered as Agent-callable tools.

These expose the existing code-reader/indexer/symbol/reference helpers to the model
via the tool registry, so the agent can actually *explore* the project it is working
in (read a file by relative path, grep for a symbol, list files) instead of only
creating files blind.

Design constraints:
- All tools resolve paths against the workspace root (WORKSPACE from file_tools),
  the SAME root used by read_file/write_file/edit_file/run_cmd. This keeps the
  agent's view of the project consistent across every tool.
- Read-only + low risk: these never mutate the project, so they need no
  confirmation and are safe to run in parallel.
- Defensive: import failures or empty indices degrade to a clear string message
  rather than raising, so the agent always gets usable feedback it can act on.
"""

from __future__ import annotations

from arforge.tool_registry import ParamSchema, register_tool


def _workspace_root():
    """Return the resolved workspace root (imported lazily so WORKSPACE rebinds
    correctly under trust-cwd / monkeypatching in tests)."""
    from arforge.tools.file_tools import get_workspace

    return str(get_workspace().resolve())


@register_tool(
    "code_search",
    "Search workspace file paths and source text for a keyword. If the keyword is an "
    "existing relative path (including a dependency path), returns that path directly. "
    "Otherwise returns matching files and the first matching line number in each. Use "
    "this to locate where a symbol/term is used before reading or editing. Searches "
    "Python text by default; set all_text=true to search every indexed text file.",
    keywords=["search code", "grep code", "查找代码", "搜索代码", "代码搜索"],
    params=[
        ParamSchema("keyword", "string", "the text to search for (case-insensitive)"),
        ParamSchema("limit", "int", "max number of files to return (default 20)", required=False, default=20),
        ParamSchema("all_text", "bool", "search all text files, not only .py (default false)", required=False, default=False),
    ],
    risk="low",
    timeout=20,
    category="read",
    source=__name__,
)
def code_search(keyword: str, limit: int = 20, all_text: bool = False) -> str:
    from pathlib import Path

    from arforge.project_scanner import scan_project

    if not keyword:
        return "ERROR: keyword is required"
    root = Path(_workspace_root()).resolve()
    normalized_keyword = keyword.strip().strip("`'\"")
    path_hint = normalized_keyword.replace("\\", "/").lstrip("./")
    # Models commonly use the search tool to check a concrete path before
    # reading it.  Previously that searched *file contents* for the path string,
    # yielding a misleading "no matches" result even when the file existed.
    # Resolve exact paths first, including dependency/build paths that the
    # project scanner intentionally excludes from broad text indexing.
    if path_hint:
        candidate = (root / Path(path_hint)).resolve()
        if candidate == root or root in candidate.parents:
            if candidate.exists():
                relative = candidate.relative_to(root).as_posix()
                kind = "directory" if candidate.is_dir() else "file"
                return f"exact path match ({kind}): {relative}"
    suffixes = None if all_text else (".py",)
    matches = []
    path_matches = []
    for item in scan_project(root, suffixes=suffixes):
        rel = item["path"]
        if path_hint.casefold() in rel.replace("\\", "/").casefold():
            path_matches.append(rel)
            if len(path_matches) >= max(1, int(limit)):
                break
        path = root / rel
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if keyword.lower() in text.lower():
            line_no = next(
                (i for i, line in enumerate(text.splitlines(), 1) if keyword.lower() in line.lower()),
                0,
            )
            matches.append(f"{rel}:{line_no}")
            if len(matches) >= max(1, int(limit)):
                break
    if path_matches:
        return f"{len(path_matches)} path match(es) for '{keyword}':\n" + "\n".join(path_matches)
    if not matches:
        return f"no matches for '{keyword}'"
    return f"{len(matches)} match(es) for '{keyword}':\n" + "\n".join(matches)


@register_tool(
    "code_read",
    "Read the contents of a source file in the workspace by relative path. Returns up "
    "to 60000 chars (UTF-8). Paths resolve against the workspace root, the same root "
    "used by read_file/edit_file/run_cmd. Prefer this to read_file when you want the "
    "raw file content for understanding code.",
    keywords=["read code", "show code", "cat code", "读取代码", "查看代码"],
    params=[
        ParamSchema("filename", "path", "path inside the workspace to read"),
    ],
    risk="low",
    timeout=10,
    output_limit=60000,
    category="read",
    source=__name__,
)
def code_read(filename: str) -> str:
    from pathlib import Path

    from arforge.code_reader import read_code_file
    from arforge.core.file_state import get_file_state_tracker
    from arforge.tools.file_tools import _resolve

    suffix = Path(str(filename)).suffix.casefold()
    office_or_binary = {
        ".doc",
        ".docx",
        ".pdf",
        ".ppt",
        ".pptx",
        ".xls",
        ".xlsx",
        ".zip",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
    }
    if suffix in office_or_binary:
        raise ValueError(
            f"code_read only supports text/source files; {suffix or 'this file'} is binary. "
            "Use read_office_document for Office/PDF artifacts or the matching media tool."
        )

    # read_code_file already enforces a root-escape guard; pass WORKSPACE as root so
    # resolution is identical to the other file tools.
    content = read_code_file(filename, root=_workspace_root(), max_chars=60000)
    get_file_state_tracker().observe(_resolve(filename))
    return content


@register_tool(
    "code_symbols",
    "Extract function, class, method, interface, struct, trait and type symbols from a source file. "
    "Supports Python (.py), JavaScript (.js/.jsx/.mjs/.cjs), TypeScript (.ts/.tsx), Go (.go), and Rust (.rs). "
    "Returns a list of {name, type, line} ordered by line number. Use this to understand the structure of "
    "a file before editing, or to locate specific definitions.",
    keywords=["symbols", "code symbols", "functions", "classes", "methods", "defs", "structure", "symbol index"],
    params=[
        ParamSchema("filename", "path", "path inside the workspace to extract symbols from"),
    ],
    risk="low",
    timeout=10,
    category="read",
    source=__name__,
)
def code_symbols(filename: str) -> str:
    """Extract symbols from a source file using tree-sitter (multi-language) or Python AST."""
    from arforge.core.symbol_index import extract_symbols_from_file, language_for
    from arforge.tools.file_tools import _resolve

    target = _resolve(filename)
    lang = language_for(target)
    if lang is None:
        # Try Python AST fallback
        try:
            from arforge.core.code_indexer import extract_python_symbols
            symbols = extract_python_symbols(str(target))
            if not symbols:
                return "No symbols found in " + filename + " (unsupported language or empty file)"
            lines = []
            for s in symbols:
                lines.append("  {:30s} {:12s} line {}".format(
                    str(s.get("name", "?")), str(s.get("type", "?")), s.get("line", 0)))
            return "Symbols in " + filename + ":" + chr(10) + chr(10).join(lines)
        except Exception:
            return "No symbols found in " + filename + " (unsupported language or empty file)"

    symbols = extract_symbols_from_file(target)
    if not symbols:
        return "No symbols found in " + filename
    lines = []
    for s in symbols:
        lines.append("  {:30s} {:12s} line {}".format(s["name"], s["type"], s["line"]))
    return "Symbols in " + filename + " (" + lang + "):" + chr(10) + chr(10).join(lines)


@register_tool(
    "list_code_files",
    "List the Python source files in the workspace (relative paths). Use this first to "
    "orient yourself in an unfamiliar project before searching or reading.",
    keywords=["list code", "python files", "列出代码", "代码文件"],
    params=[
        ParamSchema("limit", "int", "max files to return (default 100)", required=False, default=100),
    ],
    risk="low",
    timeout=15,
    category="read",
    source=__name__,
)
def list_code_files(limit: int = 100) -> str:
    from pathlib import Path

    from arforge.project_scanner import scan_project

    root = Path(_workspace_root())
    files = [
        item["path"]
        for item in scan_project(root, suffixes=(".py",))
        if "arforge_corrupt_backup" not in item["path"]
    ]
    files = files[: max(1, int(limit))]
    if not files:
        return "(no Python files in workspace)"
    return f"{len(files)} file(s):\n" + "\n".join(files)


@register_tool(
    "code_summary",
    "Produce a short structural summary of a Python file in the workspace (module "
    "docstring, top-level classes/functions with signatures). Cheaper than reading the "
    "whole file when you only need the shape of a module.",
    keywords=["summarize code", "code summary", "代码摘要", "总结代码"],
    params=[
        ParamSchema("filename", "path", "path to a Python file inside the workspace"),
    ],
    risk="low",
    timeout=10,
    category="read",
    source=__name__,
)
def code_summary(filename: str) -> str:
    from pathlib import Path

    try:
        from arforge.code_summarizer import summarize_code_file
    except Exception as exc:  # noqa: BLE001 — keep the tool robust for the agent
        return f"summarizer unavailable: {exc}"
    root = Path(_workspace_root())
    target = (root / filename).resolve()
    # Reuse the same escape guard the file tools apply.
    if root.resolve() not in target.parents and target != root.resolve():
        return f"ERROR: path escapes workspace: {filename}"
    if not target.exists():
        return f"ERROR: file not found: {filename}"
    try:
        return summarize_code_file(str(target)) or "(empty summary)"
    except Exception as exc:  # noqa: BLE001
        return f"ERROR summarizing {filename}: {exc}"


@register_tool(
    "code_consistency_plan",
    "Build a read-only cross-file consistency plan before renaming a symbol or "
    "changing a function signature. Reports definitions, references, imports, call "
    "sites and affected files so edits can be applied consistently.",
    keywords=[
        "rename symbol",
        "signature change",
        "cross file consistency",
        "绗﹀彿閲嶅懡鍚?",
        "璺ㄦ枃浠朵竴鑷?",
    ],
    params=[
        ParamSchema("symbol", "string", "existing bare symbol name to inspect"),
        ParamSchema("new_name", "string", "optional new symbol name for rename planning", required=False, default=""),
        ParamSchema("signature", "string", "optional target signature for call-site review", required=False, default=""),
        ParamSchema("limit", "int", "max references/call sites to include (default 200)", required=False, default=200),
    ],
    risk="low",
    timeout=20,
    category="read",
    source=__name__,
)
def code_consistency_plan(
    symbol: str,
    new_name: str = "",
    signature: str = "",
    limit: int = 200,
) -> str:
    from arforge.core.cross_file_consistency import analyze_symbol_change, format_symbol_change_plan

    try:
        plan = analyze_symbol_change(
            symbol,
            root=_workspace_root(),
            new_name=new_name or None,
            signature=signature or None,
            limit=limit,
        )
    except Exception as exc:  # noqa: BLE001
        return f"ERROR building consistency plan: {exc}"
    return format_symbol_change_plan(plan)


@register_tool(
    "python_symbol_rename",
    "Preview or apply a token-aware Python symbol rename across affected files. "
    "Uses the cross-file consistency plan, edits only Python NAME tokens, and "
    "requires apply=true to write changes.",
    keywords=[
        "apply symbol rename",
        "rename python symbol",
        "python_symbol_rename",
    ],
    params=[
        ParamSchema("symbol", "string", "existing bare Python symbol name"),
        ParamSchema("new_name", "string", "new bare Python identifier"),
        ParamSchema("apply", "bool", "write changes when true; default false for dry-run", required=False, default=False),
        ParamSchema("limit", "int", "max references/call sites to inspect (default 200)", required=False, default=200),
    ],
    risk="low",
    timeout=20,
    category="workspace_write",
    requires_confirmation=False,
    source=__name__,
)
def python_symbol_rename(
    symbol: str,
    new_name: str,
    apply: bool = False,
    limit: int = 200,
) -> str:
    from arforge.core.cross_file_consistency import apply_python_symbol_rename, format_python_symbol_rename

    try:
        if apply:
            from arforge.permission import request_confirmation
            from arforge.security.file_ops import confirmed_operation

            if not request_confirmation("medium", f"rename Python symbol '{symbol}' to '{new_name}'"):
                return "ERROR applying Python symbol rename: confirmation denied"
            with confirmed_operation():
                result = apply_python_symbol_rename(
                    symbol,
                    new_name,
                    root=_workspace_root(),
                    apply=True,
                    limit=limit,
                )
                return format_python_symbol_rename(result)
        result = apply_python_symbol_rename(
            symbol,
            new_name,
            root=_workspace_root(),
            apply=False,
            limit=limit,
        )
    except Exception as exc:  # noqa: BLE001
        return f"ERROR applying Python symbol rename: {exc}"
    return format_python_symbol_rename(result)


@register_tool(
    "multimodal_diagnose",
    "Diagnose an error screenshot or document by extracting text, identifying error "
    "signals, searching the workspace code, and returning repair-oriented suggestions. "
    "Works best with text/markdown logs and with images when OCR is installed.",
    keywords=[
        "diagnose screenshot",
        "ocr error",
        "multimodal diagnose",
        "document error",
        "screenshot error",
        "error document",
    ],
    params=[
        ParamSchema("filename", "path", "image or document path inside the workspace"),
        ParamSchema("extracted_text", "string", "optional extracted text override for tests or pasted OCR", required=False, default=""),
        ParamSchema("limit", "int", "max code matches to include (default 8)", required=False, default=8),
    ],
    risk="low",
    timeout=20,
    category="read",
    source=__name__,
)
def multimodal_diagnose(filename: str, extracted_text: str = "", limit: int = 8) -> str:
    from arforge.core.multimodal_diagnosis import diagnose_multimodal_file, format_multimodal_diagnosis
    from arforge.tools.file_tools import _resolve

    try:
        target = _resolve(filename)
        result = diagnose_multimodal_file(
            target,
            root=_workspace_root(),
            extracted_text=extracted_text or None,
            max_search_results=limit,
        )
    except Exception as exc:  # noqa: BLE001
        return f"ERROR diagnosing multimodal input: {exc}"
    return format_multimodal_diagnosis(result)
