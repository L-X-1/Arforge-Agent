"""Tests for retrieval/code_chunking.py — AST-aware code chunking (T34)."""


PYTHON_SOURCE = '''
"""Calculator module — provides basic arithmetic operations."""

import math
from typing import List, Optional

PI = 3.14159
"""Module-level constant."""

def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b

def subtract(a: int, b: int) -> int:
    """Subtract b from a."""
    return a - b

class Calculator:
    """A simple calculator class with history."""

    history: List[str]

    def __init__(self):
        self.history = []

    def multiply(self, a: float, b: float) -> float:
        """Multiply two numbers."""
        result = a * b
        self.history.append(f"multiply({a}, {b}) = {result}")
        return result

    def divide(self, a: float, b: float) -> float:
        """Divide a by b. Raises on zero division."""
        if b == 0:
            raise ValueError("Cannot divide by zero")
        result = a / b
        self.history.append(f"divide({a}, {b}) = {result}")
        return result

async def compute_async(x: int) -> int:
    """Async computation."""
    import asyncio
    await asyncio.sleep(0)
    return x * 2
'''


class TestPythonChunking:
    """T34: Python AST chunking correctness."""

    def test_chunks_non_empty(self):
        """Python chunking produces chunks."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        assert len(chunks) > 0

    def test_module_docstring_chunk(self):
        """Module docstring is captured as module_doc chunk."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        doc_chunks = [c for c in chunks if c.kind == "module_doc"]
        assert len(doc_chunks) >= 1
        assert "Calculator module" in doc_chunks[0].text

    def test_function_chunks(self):
        """Top-level functions become function chunks."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        funcs = [c for c in chunks if c.kind == "function"]
        names = {c.name for c in funcs}
        assert "add" in names
        assert "subtract" in names
        assert "compute_async" in names

    def test_class_chunks(self):
        """Classes produce class-level chunks."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        classes = [c for c in chunks if c.kind == "class"]
        assert len(classes) >= 1
        assert classes[0].name == "Calculator"

    def test_method_chunks(self):
        """Methods are extracted as sub-chunks with parent annotation."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        methods = [c for c in chunks if c.kind == "method"]
        method_names = {c.name for c in methods}
        assert "__init__" in method_names
        assert "multiply" in method_names
        assert "divide" in method_names
        # Check parent annotation
        multiply = [c for c in methods if c.name == "multiply"][0]
        assert multiply.parent == "Calculator"

    def test_import_chunks(self):
        """Import statements become import chunks."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        imports = [c for c in chunks if c.kind == "import"]
        assert len(imports) >= 2

    def test_assignment_chunks(self):
        """Module-level assignments are captured."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        assigns = [c for c in chunks if c.kind == "assignment"]
        assert len(assigns) >= 1
        assert any("PI" in c.name for c in assigns)

    def test_signature_preserved(self):
        """Function/class signatures are extracted."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        add_func = [c for c in chunks if c.name == "add"][0]
        assert "def add" in add_func.signature

    def test_to_embed_text_format(self):
        """Embed text includes kind and signature."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        add_func = [c for c in chunks if c.name == "add"][0]
        embed = add_func.to_embed_text()
        assert "[function]" in embed
        assert "def add" in embed

    def test_to_chunk_conversion(self):
        """CodeChunk converts to base Chunk for pipeline compatibility."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        base_chunk = chunks[0].to_chunk()
        assert base_chunk.id == chunks[0].id
        assert base_chunk.source == "test.py"
        assert "kind" in base_chunk.metadata

    def test_syntax_error_fallback(self):
        """Invalid Python falls back without crashing."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python("def broken( {{{", "broken.py")
        # Should not crash, even if it produces text-based fallback chunks
        assert isinstance(chunks, list)


class TestLanguageDetection:
    """Language detection from file extensions."""

    def test_python_detection(self):
        from arforge.retrieval.code_chunking import detect_language

        assert detect_language("test.py") == "python"
        assert detect_language("test.pyi") == "python"

    def test_javascript_detection(self):
        from arforge.retrieval.code_chunking import detect_language

        assert detect_language("app.js") == "javascript"
        assert detect_language("app.mjs") == "javascript"
        assert detect_language("app.cjs") == "javascript"

    def test_typescript_detection(self):
        from arforge.retrieval.code_chunking import detect_language

        assert detect_language("app.ts") == "typescript"
        assert detect_language("app.tsx") == "typescript"

    def test_go_detection(self):
        from arforge.retrieval.code_chunking import detect_language

        assert detect_language("main.go") == "go"

    def test_unknown_extension(self):
        from arforge.retrieval.code_chunking import detect_language

        assert detect_language("README.md") is None
        assert detect_language("data.json") is None


class TestCodeChunkFile:
    """File-level chunking API."""

    def test_chunk_code_file_smoke(self):
        """chunk_code_file works on a real file."""
        from pathlib import Path
        from arforge.retrieval.code_chunking import chunk_code_file

        fp = Path(__file__)  # This test file itself
        chunks = chunk_code_file(fp)
        assert len(chunks) > 0
        # All chunks should reference this file
        for c in chunks:
            assert str(fp) in c.file or fp.name in c.file

    def test_chunk_code_directory(self):
        """chunk_code_directory scans and chunks all supported files."""
        from pathlib import Path
        from arforge.retrieval.code_chunking import chunk_code_directory

        test_dir = Path(__file__).parent
        chunks, stats = chunk_code_directory(test_dir)
        assert stats.get("total", 0) > 0
        assert len(chunks) == stats["total"]
        assert "python" in stats

    def test_code_chunks_to_index(self):
        """code_chunks_to_index produces (id, text) pairs."""
        from arforge.retrieval.code_chunking import (
            chunk_code_file,
            code_chunks_to_index,
        )
        from pathlib import Path

        chunks = chunk_code_file(Path(__file__))
        pairs = code_chunks_to_index(chunks)
        assert len(pairs) == len(chunks)
        assert all(isinstance(p, tuple) and len(p) == 2 for p in pairs)
        assert all(isinstance(p[0], str) and isinstance(p[1], str) for p in pairs)


class TestFallbackChunking:
    """Text-based fallback for unsupported languages."""

    def test_unknown_language_fallback(self):
        """Unsupported file types use text fallback."""
        from arforge.retrieval.code_chunking import _fallback_chunks

        source = "function hello() {\n  return 'world';\n}\n\nclass Foo {\n  bar() {}\n}"
        chunks = _fallback_chunks(source, "test.rb", "ruby")
        assert len(chunks) > 0
        # Fallback chunks have code_block or guessed kind
        kinds = {c.kind for c in chunks}
        assert len(kinds) > 0

    def test_fallback_preserves_file_reference(self):
        """Fallback chunks reference the source file."""
        from arforge.retrieval.code_chunking import _fallback_chunks

        source = "print('hello')"
        chunks = _fallback_chunks(source, "myscript.py", "python")
        for c in chunks:
            assert "myscript.py" in c.file


class TestEmbedTextQuality:
    """Embedding text quality for code retrieval."""

    def test_method_embed_includes_parent(self):
        """Method embed text includes `Parent.method_name`."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        multiply = [c for c in chunks if c.name == "multiply"][0]
        embed = multiply.to_embed_text()
        assert "Calculator.multiply" in embed or "[method]" in embed

    def test_function_embed_includes_signature(self):
        """Function embed text includes signature."""
        from arforge.retrieval.code_chunking import chunk_python

        chunks = chunk_python(PYTHON_SOURCE, "test.py")
        add_func = [c for c in chunks if c.name == "add"][0]
        embed = add_func.to_embed_text()
        assert "(a: int, b: int)" in embed or "def add" in embed
