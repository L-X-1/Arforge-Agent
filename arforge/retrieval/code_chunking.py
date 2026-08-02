"""AST-aware code chunking for code RAG (T34).

Splits source files into semantic units using tree-sitter (JS/TS/Go) and
Python's built-in ast module. Each chunk preserves function/class/method
boundaries, imports, and docstrings — far superior to text-based chunking
for code retrieval tasks.

Design:
  - Python → stdlib ast (zero-dep, always available)
  - JS/TS/Go → tree-sitter (graceful fallback to text chunking if unavailable)
  - Each chunk is a standalone semantic unit with metadata (kind, name, line range)
  - Chunks are ~200-800 tokens — ideal for embedding and retrieval
"""

from __future__ import annotations

import ast as py_ast
import os
from dataclasses import dataclass, field
from pathlib import Path

from arforge.retrieval.chunking import Chunk, estimate_tokens

# ── Language mapping ──────────────────────────────────────────────

_LANG_MAP = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".go": "go",
}

_SUPPORTED_EXTS = set(_LANG_MAP)


def detect_language(filepath: str | Path) -> str | None:
    """Detect programming language from file extension."""
    ext = os.path.splitext(str(filepath))[1].lower()
    return _LANG_MAP.get(ext)


# ── Python AST chunking (stdlib — always works) ────────────────────


@dataclass
class CodeChunk:
    """A single semantic code unit extracted from source."""
    id: str
    text: str
    file: str
    line_start: int
    line_end: int
    kind: str = ""        # function / class / method / import / module_doc
    name: str = ""        # symbol name (e.g. "MyClass", "process_data")
    signature: str = ""   # function/class signature line
    language: str = "python"
    parent: str = ""      # enclosing class/module name
    metadata: dict = field(default_factory=dict)

    def to_embed_text(self) -> str:
        """Text representation optimized for embedding."""
        parts = []
        if self.signature:
            parts.append(f"[{self.kind}] {self.signature}")
        else:
            parts.append(f"[{self.kind}] {self.name}" if self.name else f"[{self.kind}]")
        if self.parent and self.kind == "method":
            parts[0] = f"[method] {self.parent}.{self.name}"
        parts.append(self.text)
        return "\n".join(parts)

    def to_chunk(self) -> Chunk:
        """Convert to base Chunk type for pipeline compatibility."""
        return Chunk(
            id=self.id,
            text=self.to_embed_text(),
            source=self.file,
            metadata={
                "kind": self.kind,
                "name": self.name,
                "signature": self.signature,
                "line_start": self.line_start,
                "line_end": self.line_end,
                "language": self.language,
                "parent": self.parent,
            },
        )


def _source_lines(source: str) -> list[str]:
    return source.splitlines()


def _extract_source(lines: list[str], start: int, end: int) -> str:
    """Extract source text for line range [start, end] (1-based, inclusive)."""
    return "\n".join(lines[start - 1 : end])


def _get_signature(lines: list[str], node: py_ast.AST) -> str:
    """Extract the first line (signature) of a function or class."""
    if hasattr(node, "lineno"):
        first_line = lines[node.lineno - 1].strip() if node.lineno <= len(lines) else ""
        return first_line
    return ""


def chunk_python(source: str, filepath: str = "") -> list[CodeChunk]:
    """Split Python source into AST-aware semantic chunks.

    Produces chunks for: module docstring, imports, top-level functions,
    classes (with their methods as sub-chunks), and top-level assignments.
    """
    try:
        tree = py_ast.parse(source)
    except SyntaxError:
        # Fall back to text-based chunking
        return _fallback_chunks(source, filepath, "python")

    lines = _source_lines(source)
    chunks: list[CodeChunk] = []
    visited: set[int] = set()

    def make_id(kind: str, name: str, line: int) -> str:
        fname = os.path.basename(filepath) if filepath else "inline"
        return f"{fname}:{kind}:{name}:L{line}"

    # Module docstring
    doc = py_ast.get_docstring(tree)
    if doc:
        chunks.append(CodeChunk(
            id=make_id("module_doc", "module", 1),
            text=f'"""\n{doc}\n"""',
            file=filepath,
            line_start=1,
            line_end=doc.count("\n") + 3,
            kind="module_doc",
            name="__doc__",
            language="python",
        ))

    for node in py_ast.iter_child_nodes(tree):
        if isinstance(node, (py_ast.Import, py_ast.ImportFrom)):
            start = node.lineno
            end = node.end_lineno or start
            visited.update(range(start, end + 1))
            chunks.append(CodeChunk(
                id=make_id("import", "imports", start),
                text=_extract_source(lines, start, end),
                file=filepath,
                line_start=start,
                line_end=end,
                kind="import",
                name="imports",
                language="python",
            ))

        elif isinstance(node, (py_ast.FunctionDef, py_ast.AsyncFunctionDef)):
            start = node.lineno
            end = node.end_lineno or start
            visited.update(range(start, end + 1))
            sig = _get_signature(lines, node)
            chunks.append(CodeChunk(
                id=make_id("function", node.name, start),
                text=_extract_source(lines, start, end),
                file=filepath,
                line_start=start,
                line_end=end,
                kind="function",
                name=node.name,
                signature=sig,
                language="python",
            ))

        elif isinstance(node, py_ast.ClassDef):
            start = node.lineno
            end = node.end_lineno or start
            visited.update(range(start, end + 1))
            sig = _get_signature(lines, node)
            # Class-level chunk (full class body)
            chunks.append(CodeChunk(
                id=make_id("class", node.name, start),
                text=_extract_source(lines, start, end),
                file=filepath,
                line_start=start,
                line_end=end,
                kind="class",
                name=node.name,
                signature=sig,
                language="python",
            ))
            # Methods as sub-chunks
            for child in py_ast.iter_child_nodes(node):
                if isinstance(child, (py_ast.FunctionDef, py_ast.AsyncFunctionDef)):
                    m_start = child.lineno
                    m_end = child.end_lineno or m_start
                    m_sig = _get_signature(lines, child)
                    chunks.append(CodeChunk(
                        id=make_id("method", f"{node.name}.{child.name}", m_start),
                        text=_extract_source(lines, m_start, m_end),
                        file=filepath,
                        line_start=m_start,
                        line_end=m_end,
                        kind="method",
                        name=child.name,
                        signature=m_sig,
                        language="python",
                        parent=node.name,
                    ))

    # Catch unvisited top-level assignments
    for node in py_ast.iter_child_nodes(tree):
        if isinstance(node, py_ast.Assign) and node.lineno not in visited:
            start = node.lineno
            end = node.end_lineno or start
            target_names = []
            for t in node.targets:
                if isinstance(t, py_ast.Name):
                    target_names.append(t.id)
            name = ", ".join(target_names) if target_names else "assign"
            chunks.append(CodeChunk(
                id=make_id("assign", name, start),
                text=_extract_source(lines, start, end),
                file=filepath,
                line_start=start,
                line_end=end,
                kind="assignment",
                name=name,
                language="python",
            ))

    return chunks


# ── Tree-sitter chunking (JS/TS/Go) ─────────────────────────────────

_TS_CHUNK_TYPES = {
    "javascript": {
        "function_declaration", "generator_function_declaration",
        "class_declaration", "method_definition",
        "arrow_function", "lexical_declaration",
        "export_statement", "import_statement",
    },
    "typescript": {
        "function_declaration", "generator_function_declaration",
        "class_declaration", "abstract_class_declaration",
        "method_definition", "interface_declaration",
        "type_alias_declaration", "enum_declaration",
        "lexical_declaration", "export_statement",
        "import_statement",
    },
    "go": {
        "function_declaration", "method_declaration",
        "type_declaration", "import_declaration",
        "var_declaration", "const_declaration",
    },
}

_KIND_LABEL = {
    "function_declaration": "function",
    "generator_function_declaration": "function",
    "method_definition": "method",
    "method_declaration": "method",
    "class_declaration": "class",
    "abstract_class_declaration": "class",
    "interface_declaration": "interface",
    "type_alias_declaration": "type",
    "enum_declaration": "enum",
    "type_declaration": "type",
    "arrow_function": "function",
    "lexical_declaration": "const",
    "var_declaration": "var",
    "const_declaration": "const",
    "import_statement": "import",
    "import_declaration": "import",
    "export_statement": "export",
}

_ts_parsers: dict[str, object] = {}


def _get_ts_parser(lang: str) -> object | None:
    """Lazy-load tree-sitter parser for a language. Returns None on failure."""
    if lang in _ts_parsers:
        return _ts_parsers[lang]

    try:
        import tree_sitter
    except ImportError:
        _ts_parsers[lang] = None
        return None

    try:
        # Map language name to tree-sitter language module
        lang_modules = {
            "javascript": "tree_sitter_javascript",
            "typescript": "tree_sitter_typescript",
            "go": "tree_sitter_go",
        }
        mod_name = lang_modules.get(lang)
        if mod_name is None:
            _ts_parsers[lang] = None
            return None

        mod = __import__(mod_name, fromlist=["language"])
        ts_lang = mod.language()

        parser = tree_sitter.Parser()
        parser.set_language(ts_lang)
        _ts_parsers[lang] = parser
        return parser
    except (ImportError, AttributeError, OSError):
        _ts_parsers[lang] = None
        return None


def chunk_tree_sitter(source: str, filepath: str, lang: str) -> list[CodeChunk]:
    """Split source using tree-sitter for JS/TS/Go."""
    parser = _get_ts_parser(lang)
    if parser is None:
        return _fallback_chunks(source, filepath, lang)


    try:
        tree = parser.parse(bytes(source, "utf-8"))
    except Exception:
        return _fallback_chunks(source, filepath, lang)

    lines = _source_lines(source)
    chunk_types = _TS_CHUNK_TYPES.get(lang, set())
    chunks: list[CodeChunk] = []

    fname = os.path.basename(filepath) if filepath else "inline"

    def _walk(node, depth: int = 0):
        if node.type in chunk_types and node.child_count > 0:
            start_byte = node.start_byte
            end_byte = node.end_byte
            text = source[start_byte:end_byte]
            if len(text.strip()) < 3:
                return

            start_row = node.start_point[0] + 1
            end_row = node.end_point[0] + 1
            first_line = lines[start_row - 1].strip() if start_row <= len(lines) else ""

            # Get name from named child
            name = ""
            for child in node.children:
                if child.type in ("identifier", "property_identifier", "type_identifier"):
                    name = source[child.start_byte:child.end_byte].decode("utf-8") if isinstance(source, bytes) else source[child.start_byte:child.end_byte]
                    break

            kind = _KIND_LABEL.get(node.type, node.type)
            cid = f"{fname}:{kind}:{name}:L{start_row}" if name else f"{fname}:{kind}:L{start_row}"

            chunks.append(CodeChunk(
                id=cid,
                text=text if isinstance(text, str) else text.decode("utf-8"),
                file=filepath,
                line_start=start_row,
                line_end=end_row,
                kind=kind,
                name=name,
                signature=first_line,
                language=lang,
            ))
            return  # Don't recurse into children of chunk-level nodes

        for child in node.children:
            _walk(child, depth + 1)

    try:
        _walk(tree.root_node)
    except Exception:
        return _fallback_chunks(source, filepath, lang)

    return chunks


# ── Fallback text chunking ──────────────────────────────────────────


def _fallback_chunks(source: str, filepath: str, lang: str) -> list[CodeChunk]:
    """Text-based fallback: split on blank lines and function-like patterns."""
    from arforge.retrieval.chunking import chunk_text

    text_chunks = chunk_text(source, max_tokens=600, overlap_tokens=50)
    chunks: list[CodeChunk] = []
    fname = os.path.basename(filepath) if filepath else "inline"

    for tc in text_chunks:
        # Try to guess kind from content
        first_line = tc.text.split("\n")[0].strip() if tc.text else ""
        kind = "code_block"
        name = ""
        if first_line.startswith("def "):
            kind = "function"
            name = first_line[4:].split("(")[0].strip()
        elif first_line.startswith("class "):
            kind = "class"
            name = first_line[6:].split("(")[0].split(":")[0].strip()
        elif first_line.startswith(("import ", "from ")):
            kind = "import"

        chunks.append(CodeChunk(
            id=f"{fname}:{kind}:{name}:{tc.metadata.get('chunk_index', 0)}",
            text=tc.text,
            file=filepath,
            line_start=tc.metadata.get("line_start", 0),
            line_end=tc.metadata.get("line_end", 0),
            kind=kind,
            name=name,
            language=lang,
        ))

    return chunks


# ── Public API ──────────────────────────────────────────────────────


def chunk_code_file(filepath: str | Path, max_chunk_tokens: int = 800) -> list[CodeChunk]:
    """AST-aware chunking for a single code file. Auto-detects language."""
    fp = Path(filepath)
    lang = detect_language(str(fp))
    if lang is None:
        # Unsupported language — fall back to text chunking
        source = fp.read_text(encoding="utf-8", errors="replace")
        return _fallback_chunks(source, str(fp), "unknown")

    source = fp.read_text(encoding="utf-8", errors="replace")

    if lang == "python":
        chunks = chunk_python(source, str(fp))
    else:
        chunks = chunk_tree_sitter(source, str(fp), lang)

    # Filter oversized chunks
    result = []
    for c in chunks:
        if estimate_tokens(c.text) > max_chunk_tokens * 2:
            # Oversized — sub-chunk using text-based chunking
            from arforge.retrieval.chunking import chunk_text
            sub_chunks = chunk_text(c.text, max_tokens=max_chunk_tokens, overlap_tokens=100)
            for sc in sub_chunks:
                result.append(CodeChunk(
                    id=f"{c.id}_p{sc.metadata.get('chunk_index', 0)}",
                    text=sc.text,
                    file=c.file,
                    line_start=c.line_start,
                    line_end=c.line_end,
                    kind=c.kind,
                    name=c.name,
                    signature=c.signature,
                    language=c.language,
                    parent=c.parent,
                    metadata={"sub_chunk": True, "parent_id": c.id},
                ))
        else:
            result.append(c)

    return result


def chunk_code_directory(
    directory: str | Path,
    extensions: tuple[str, ...] = (".py", ".js", ".jsx", ".ts", ".tsx", ".go"),
    max_chunk_tokens: int = 800,
) -> tuple[list[CodeChunk], dict]:
    """AST-aware chunking for all supported files in a directory.

    Returns (chunks, stats_dict).
    """
    base = Path(directory).resolve()
    all_chunks: list[CodeChunk] = []
    stats: dict[str, int] = {}

    for root, _, files in os.walk(base):
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in extensions:
                continue
            fp = Path(root) / fn
            try:
                chunks = chunk_code_file(fp, max_chunk_tokens=max_chunk_tokens)
                all_chunks.extend(chunks)
                lang = detect_language(fn) or "unknown"
                stats[lang] = stats.get(lang, 0) + len(chunks)
            except Exception:
                continue

    stats["total"] = len(all_chunks)
    return all_chunks, stats


def code_chunks_to_index(chunks: list[CodeChunk]) -> list[tuple[str, str]]:
    """Convert CodeChunks to (id, text) pairs for HybridRetriever.index()."""
    return [(c.id, c.to_embed_text()) for c in chunks]
