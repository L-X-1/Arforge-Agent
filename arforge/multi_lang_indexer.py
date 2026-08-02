"""Multi-language symbol indexer using tree-sitter.

Supports: JavaScript (.js, .jsx), TypeScript (.ts, .tsx), Go (.go), Rust (.rs).
Integrates with the existing code_search pipeline.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from arforge.project_scanner import scan_project

# ---------------------------------------------------------------------------
# Language support — lazy-loaded
# ---------------------------------------------------------------------------

_LANGUAGES: dict[str, tuple] = {}
_PARSERS: dict[str, object] = {}
_INDEXED: dict[str, list[dict]] = {}
_INDEX_ROOT: Optional[Path] = None


def _init_js() -> bool:
    """Initialize JavaScript/JSX parser."""
    if "javascript" in _LANGUAGES:
        return True
    try:
        import tree_sitter_javascript as tsjs
        from tree_sitter import Language, Parser

        lang = Language(tsjs.language())
        _LANGUAGES["javascript"] = (lang, (".js", ".jsx", ".mjs", ".cjs"))
        _PARSERS["javascript"] = Parser(lang)
        return True
    except ImportError:
        return False


def _init_typescript() -> bool:
    """Initialize TypeScript/TSX parser."""
    if "typescript" in _LANGUAGES:
        return True
    try:
        import tree_sitter_typescript as tsts
        from tree_sitter import Language, Parser

        ts_lang = Language(tsts.language_typescript())
        _LANGUAGES["typescript"] = (ts_lang, (".ts",))
        _PARSERS["typescript"] = Parser(ts_lang)

        tsx_lang = Language(tsts.language_tsx())
        _LANGUAGES["tsx"] = (tsx_lang, (".tsx",))
        _PARSERS["tsx"] = Parser(tsx_lang)
        return True
    except ImportError:
        return False


def _init_go() -> bool:
    """Initialize Go parser."""
    if "go" in _LANGUAGES:
        return True
    try:
        import tree_sitter_go as tsgo
        from tree_sitter import Language, Parser

        lang = Language(tsgo.language())
        _LANGUAGES["go"] = (lang, (".go",))
        _PARSERS["go"] = Parser(lang)
        return True
    except ImportError:
        return False


def _init_rust() -> bool:
    """Initialize Rust parser."""
    if "rust" in _LANGUAGES:
        return True
    try:
        import tree_sitter_rust as tsrust
        from tree_sitter import Language, Parser

        lang = Language(tsrust.language())
        _LANGUAGES["rust"] = (lang, (".rs",))
        _PARSERS["rust"] = Parser(lang)
        return True
    except ImportError:
        return False


_LANG_INIT = {
    "javascript": _init_js,
    "typescript": _init_typescript,
    "tsx": _init_typescript,
    "go": _init_go,
    "rust": _init_rust,
}

_SUFFIX_TO_LANG: dict[str, str] = {
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
}


# ---------------------------------------------------------------------------
# Symbol extraction per language
# ---------------------------------------------------------------------------

_FUNCTION_TYPES = {
    "function_declaration",
    "method_definition",
    "arrow_function",
    "function_expression",
    "generator_function_declaration",
    "generator_function_expression",
}

_CLASS_TYPES = {
    "class_declaration",
    "class_expression",
    "abstract_class_declaration",
}

_VARIABLE_TYPES = {
    "variable_declarator",
    "lexical_declaration",
    "const_declaration",
    "let_declaration",
    "var_declaration",
}

_INTERFACE_TYPES = {
    "interface_declaration",
    "type_alias_declaration",
}

_EXPORT_TYPES = {
    "export_statement",
    "export_default_declaration",
}

_GO_FUNCTION_TYPES = {
    "function_declaration",
    "method_declaration",
}

_GO_TYPE_TYPES = {
    "type_declaration",
    "type_spec",
    "struct_type",
    "interface_type",
}

_RUST_FUNCTION_TYPES = {
    "function_item",
    "function_signature_item",
}

_RUST_TYPE_TYPES = {
    "struct_item",
    "enum_item",
    "trait_item",
    "impl_item",
    "type_item",
}


def _extract_js_symbols(node, symbols: list[dict], source: bytes, file_path: str) -> None:
    """Recursively extract JS/TS symbols from a tree-sitter node."""
    node_type = node.type

    # Function declarations
    if node_type in _FUNCTION_TYPES:
        name_node = node.child_by_field_name("name")
        if name_node:
            name = source[name_node.start_byte:name_node.end_byte].decode("utf-8", errors="replace")
            symbols.append({
                "name": name,
                "kind": "function",
                "file": file_path,
                "line": node.start_point[0] + 1,
                "lang": "js",
            })

    # Class declarations
    if node_type in _CLASS_TYPES:
        name_node = node.child_by_field_name("name")
        if name_node:
            name = source[name_node.start_byte:name_node.end_byte].decode("utf-8", errors="replace")
            symbols.append({
                "name": name,
                "kind": "class",
                "file": file_path,
                "line": node.start_point[0] + 1,
                "lang": "js",
            })

    # Interface/type declarations (TS)
    if node_type in _INTERFACE_TYPES:
        name_node = node.child_by_field_name("name")
        if name_node:
            name = source[name_node.start_byte:name_node.end_byte].decode("utf-8", errors="replace")
            symbols.append({
                "name": name,
                "kind": "interface",
                "file": file_path,
                "line": node.start_point[0] + 1,
                "lang": "ts",
            })

    # Top-level const/let/var with meaningful names
    if node_type == "variable_declaration" or node_type == "lexical_declaration":
        for child in node.children:
            if child.type == "variable_declarator":
                name_node = child.child_by_field_name("name")
                if name_node:
                    name = source[name_node.start_byte:name_node.end_byte].decode("utf-8", errors="replace")
                    # Only index named exports and meaningful declarations
                    if name and len(name) > 1 and name[0].isupper() or name.startswith("use"):
                        symbols.append({
                            "name": name,
                            "kind": "variable",
                            "file": file_path,
                            "line": node.start_point[0] + 1,
                            "lang": "js",
                        })

    # Export declarations
    if node_type in _EXPORT_TYPES:
        for child in node.children:
            if child.type in _FUNCTION_TYPES or child.type in _CLASS_TYPES:
                name_node = child.child_by_field_name("name")
                if not name_node:
                    continue
                name = source[name_node.start_byte:name_node.end_byte].decode("utf-8", errors="replace")
                symbols.append({
                    "name": name,
                    "kind": "export",
                    "file": file_path,
                    "line": child.start_point[0] + 1,
                    "lang": "js",
                })

    # Recurse
    for child in node.children:
        _extract_js_symbols(child, symbols, source, file_path)


def _extract_go_symbols(node, symbols: list[dict], source: bytes, file_path: str) -> None:
    """Recursively extract Go symbols."""
    node_type = node.type

    if node_type in _GO_FUNCTION_TYPES:
        name_node = node.child_by_field_name("name")
        if name_node:
            name = source[name_node.start_byte:name_node.end_byte].decode("utf-8", errors="replace")
            kind = "method" if node_type == "method_declaration" else "function"
            symbols.append({
                "name": name,
                "kind": kind,
                "file": file_path,
                "line": node.start_point[0] + 1,
                "lang": "go",
            })

    if node_type == "type_spec":
        name_node = node.child_by_field_name("name")
        if name_node:
            name = source[name_node.start_byte:name_node.end_byte].decode("utf-8", errors="replace")
            symbols.append({
                "name": name,
                "kind": "type",
                "file": file_path,
                "line": node.start_point[0] + 1,
                "lang": "go",
            })

    for child in node.children:
        _extract_go_symbols(child, symbols, source, file_path)


def _extract_rust_symbols(node, symbols: list[dict], source: bytes, file_path: str) -> None:
    """Extract Rust symbols using the same advanced contract as file tools."""
    from arforge.core.symbol_index import extract_rust_symbols_from_tree

    del source  # The parsed tree already owns the source bytes.
    for item in extract_rust_symbols_from_tree(node):
        mapped = dict(item)
        mapped["kind"] = mapped.pop("type")
        mapped["file"] = file_path
        mapped["lang"] = "rust"
        symbols.append(mapped)


_EXTRACTORS = {
    "javascript": _extract_js_symbols,
    "typescript": _extract_js_symbols,
    "tsx": _extract_js_symbols,
    "go": _extract_go_symbols,
    "rust": _extract_rust_symbols,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def available_languages() -> list[str]:
    """Return list of available tree-sitter languages."""
    result = []
    for name, init_fn in _LANG_INIT.items():
        if init_fn():
            result.append(name)
    return sorted(set(result))


def index_multi_lang(root: str | Path = ".") -> dict:
    """Index all supported multi-language files in a project.

    Returns dict with per-language symbol counts.
    """
    global _INDEX_ROOT, _INDEXED

    base = Path(root).resolve()
    _INDEX_ROOT = base
    _INDEXED = {}

    # Initialize all available languages
    for name, init_fn in _LANG_INIT.items():
        init_fn()

    # Determine which suffixes to scan
    suffixes = set()
    for lang_name in _LANGUAGES:
        suffixes.update(_LANGUAGES[lang_name][1])

    stats = {}
    total = 0

    for item in scan_project(base, suffixes=tuple(suffixes)):
        file_path = item["path"]
        suffix = Path(file_path).suffix.lower()
        if suffix not in _SUFFIX_TO_LANG:
            continue

        lang_name = _SUFFIX_TO_LANG[suffix]
        if lang_name not in _PARSERS:
            continue

        full_path = base / file_path
        try:
            source = full_path.read_bytes()
        except (OSError, PermissionError):
            continue

        parser = _PARSERS[lang_name]
        try:
            tree = parser.parse(source)
        except Exception:
            continue

        extractor = _EXTRACTORS.get(lang_name)
        if not extractor:
            continue

        symbols: list[dict] = []
        extractor(tree.root_node, symbols, source, file_path)

        if lang_name not in _INDEXED:
            _INDEXED[lang_name] = []
        _INDEXED[lang_name].extend(symbols)
        stats[lang_name] = stats.get(lang_name, 0) + len(symbols)
        total += len(symbols)

    return {"success": True, "symbols": total, "by_language": stats}


def search_multi_lang_symbol(
    symbol_name: str,
    match_mode: str = "substring",
    languages: list[str] | None = None,
    limit: int = 50,
) -> list[dict]:
    """Search multi-language symbols by name.

    Args:
        symbol_name: Name to search for
        match_mode: "exact", "prefix", or "substring"
        languages: Filter by language (e.g., ["javascript", "typescript"])
        limit: Max results
    """
    if not _INDEXED:
        index_multi_lang()

    target = symbol_name.lower()
    results = []

    for lang_name, symbols in _INDEXED.items():
        if languages and lang_name not in languages:
            continue
        for sym in symbols:
            name_low = sym["name"].lower()
            if match_mode == "exact" and name_low == target:
                results.append(sym)
            elif match_mode == "prefix" and name_low.startswith(target):
                results.append(sym)
            elif match_mode == "substring" and target in name_low:
                results.append(sym)

    return results[:limit]


def list_multi_lang_symbols(limit: int = 100, language: str | None = None) -> list[dict]:
    """List all multi-language symbols."""
    if not _INDEXED:
        index_multi_lang()

    results = []
    for lang_name, symbols in _INDEXED.items():
        if language and lang_name != language:
            continue
        results.extend(symbols)

    return results[:limit]


def get_index_status() -> dict:
    """Get multi-language index status."""
    if not _INDEXED:
        return {"indexed": False, "languages": available_languages()}

    return {
        "indexed": True,
        "languages": available_languages(),
        "counts": {k: len(v) for k, v in _INDEXED.items()},
        "total": sum(len(v) for v in _INDEXED.values()),
    }


def search_code_multi(
    keyword: str,
    root: str | Path = ".",
    limit: int = 20,
    suffixes: tuple[str, ...] = (".py", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs"),
) -> list[dict]:
    """Search code text across multiple languages."""
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
