"""Tests for multi-language tree-sitter symbol indexer."""

import pytest
import tempfile
from pathlib import Path


class TestMultiLangIndexer:
    """Tests for multi_lang_indexer.py."""

    def test_available_languages(self):
        from arforge.multi_lang_indexer import available_languages
        langs = available_languages()
        assert "javascript" in langs
        assert "typescript" in langs
        assert "tsx" in langs

    def test_index_javascript(self):
        from arforge.multi_lang_indexer import (
            _init_js, _init_typescript, _PARSERS, _EXTRACTORS
        )
        assert _init_js()
        assert _init_typescript()
        assert "javascript" in _PARSERS

        source = b"function hello() { return 1; }\nclass MyClass { method() {} }\nconst App = () => {};"
        parser = _PARSERS["javascript"]
        tree = parser.parse(source)
        symbols = []
        _EXTRACTORS["javascript"](tree.root_node, symbols, source, "test.js")
        names = [s["name"] for s in symbols]
        assert "hello" in names
        assert "MyClass" in names
        assert any(s["kind"] == "function" for s in symbols)
        assert any(s["kind"] == "class" for s in symbols)

    def test_index_typescript(self):
        from arforge.multi_lang_indexer import (
            _init_typescript, _PARSERS, _EXTRACTORS
        )
        _init_typescript()

        source = b'interface User { name: string; }\ntype Status = "active";\nfunction getUser(id: number): User { return { name: "x", age: 0 }; }'
        parser = _PARSERS["typescript"]
        tree = parser.parse(source)
        symbols = []
        _EXTRACTORS["typescript"](tree.root_node, symbols, source, "test.ts")
        names = [s["name"] for s in symbols]
        assert "User" in names
        assert "Status" in names
        assert "getUser" in names

    def test_index_tsx(self):
        from arforge.multi_lang_indexer import (
            _init_typescript, _PARSERS, _EXTRACTORS
        )
        _init_typescript()

        source = b'import React from "react";\ninterface Props { title: string; }\nconst Header: React.FC<Props> = ({ title }) => { return <h1>{title}</h1>; };\nexport default Header;'
        parser = _PARSERS["tsx"]
        tree = parser.parse(source)
        symbols = []
        _EXTRACTORS["tsx"](tree.root_node, symbols, source, "test.tsx")
        names = [s["name"] for s in symbols]
        assert "Props" in names
        assert "Header" in names

    def test_index_go(self):
        try:
            from arforge.multi_lang_indexer import (
                _init_go, _PARSERS, _EXTRACTORS
            )
            if not _init_go():
                pytest.skip("tree-sitter-go not available")
        except Exception:
            pytest.skip("tree-sitter-go not available")

        source = b'package main\nfunc Hello() string { return "hello" }\ntype User struct { Name string }'
        parser = _PARSERS["go"]
        tree = parser.parse(source)
        symbols = []
        _EXTRACTORS["go"](tree.root_node, symbols, source, "test.go")
        names = [s["name"] for s in symbols]
        assert "Hello" in names
        assert "User" in names

    def test_index_rust(self):
        try:
            from arforge.multi_lang_indexer import (
                _init_rust, _PARSERS, _EXTRACTORS
            )
            if not _init_rust():
                pytest.skip("tree-sitter-rust not available")
        except Exception:
            pytest.skip("tree-sitter-rust not available")

        source = b'fn main() { println!("hello"); }\nstruct Point { x: f64, y: f64 }\ntrait Drawable { fn draw(&self); }'
        parser = _PARSERS["rust"]
        tree = parser.parse(source)
        symbols = []
        _EXTRACTORS["rust"](tree.root_node, symbols, source, "test.rs")
        names = [s["name"] for s in symbols]
        assert "main" in names
        assert "Point" in names
        assert "Drawable" in names

    def test_index_rust_advanced_contract_matches_file_index(self):
        from arforge.multi_lang_indexer import _EXTRACTORS, _PARSERS, _init_rust

        if not _init_rust():
            pytest.skip("tree-sitter-rust not available")
        source = b"""pub mod api {
use crate::{Task, Result as AppResult};
pub trait Repository<T> where T: Clone { type Error; fn get(&self) -> AppResult<T>; }
pub struct Store<T> { pub value: T }
impl<T> Repository<T> for Store<T> where T: Clone { type Error = (); fn get(&self) -> AppResult<T> { todo!() } }
extern \"C\" { pub fn native_call(value: i32) -> i32; }
}
"""
        tree = _PARSERS["rust"].parse(source)
        symbols = []
        _EXTRACTORS["rust"](tree.root_node, symbols, source, "src/lib.rs")

        assert all(symbol["file"] == "src/lib.rs" and symbol["lang"] == "rust" for symbol in symbols)
        task_import = next(symbol for symbol in symbols if symbol["name"] == "Task")
        assert task_import["kind"] == "import"
        assert task_import["import_path"] == "crate::Task"
        implementation = next(symbol for symbol in symbols if symbol["kind"] == "impl")
        assert implementation["name"] == "Repository<T> for Store<T>"
        assert implementation["impl_target"] == "Store<T>"
        assert any(symbol["kind"] == "method" and symbol["name"] == "get" for symbol in symbols)
        assert any(symbol["kind"] == "associated_type" and symbol["name"] == "Error" for symbol in symbols)
        assert any(symbol["kind"] == "foreign_function" for symbol in symbols)

    def test_index_multi_lang_directory(self):
        """Index a real multi-language directory."""
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "app.js").write_text("function hello() { return 1; }", encoding="utf-8")
            (d / "types.ts").write_text("interface User { name: string; }", encoding="utf-8")
            (d / "main.go").write_text("package main\nfunc Hello() string { return \"x\" }", encoding="utf-8")
            (d / "lib.rs").write_text("fn main() {}\npub struct Point { x: f64 }", encoding="utf-8")

            from arforge.multi_lang_indexer import index_multi_lang
            result = index_multi_lang(d)
            assert result["success"]
            assert result["symbols"] >= 3

    def test_search_multi_lang_symbol(self):
        """Test searching after indexing."""
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "lib.js").write_text(
                "function calculateSum(a, b) { return a + b; }\n"
                "function calculateProduct(x, y) { return x * y; }\n",
                encoding="utf-8",
            )
            (d / "types.d.ts").write_text(
                "interface Calculator { sum(a: number, b: number): number; }",
                encoding="utf-8",
            )
            from arforge.multi_lang_indexer import index_multi_lang, search_multi_lang_symbol
            index_multi_lang(d)

            results = search_multi_lang_symbol("calculateSum", match_mode="exact")
            assert len(results) >= 1
            assert results[0]["name"] == "calculateSum"

            results = search_multi_lang_symbol("calculate", match_mode="prefix")
            assert len(results) >= 2

            results = search_multi_lang_symbol("Sum", match_mode="substring")
            assert len(results) >= 1

            results_js = search_multi_lang_symbol(
                "calculate", match_mode="prefix", languages=["javascript"]
            )
            assert all(r["lang"] == "js" for r in results_js)

    def test_search_rust_advanced_symbols_after_project_index(self, tmp_path):
        from arforge.multi_lang_indexer import index_multi_lang, search_multi_lang_symbol

        (tmp_path / "lib.rs").write_text(
            "use crate::model::Task;\n"
            "trait Repo<T> { fn get(&self) -> T; }\n"
            "struct Store<T>(T);\n"
            "impl<T: Clone> Repo<T> for Store<T> { fn get(&self) -> T { self.0.clone() } }\n",
            encoding="utf-8",
        )
        result = index_multi_lang(tmp_path)
        assert result["success"] is True
        assert result["by_language"]["rust"] >= 6

        imported = search_multi_lang_symbol("Task", match_mode="exact", languages=["rust"])
        assert imported and imported[0]["import_path"] == "crate::model::Task"
        implementations = search_multi_lang_symbol(
            "Repo<T> for Store<T>", match_mode="exact", languages=["rust"]
        )
        assert implementations and implementations[0]["kind"] == "impl"
        methods = search_multi_lang_symbol("get", match_mode="exact", languages=["rust"])
        assert len(methods) == 2
        assert all(method["kind"] == "method" for method in methods)

    def test_get_index_status(self):
        from arforge.multi_lang_indexer import get_index_status
        status = get_index_status()
        assert "languages" in status
        assert isinstance(status["languages"], list)


class TestCodeIndexerMultiLang:
    """Tests for updated code_indexer.py with multi-language support."""

    def test_search_symbol_multi_lang_basic(self):
        from arforge.code_indexer import search_symbol_multi_lang
        results = search_symbol_multi_lang("main", limit=10)
        assert isinstance(results, list)

    def test_search_code_multi(self):
        from arforge.code_indexer import search_code
        results = search_code("import", limit=5)
        assert isinstance(results, list)


class TestSymbolNavigationMultiLang:
    """Tests for symbol_navigator.py integration."""

    def test_navigation_answer(self):
        from arforge.symbol_navigator import navigation_answer
        result = navigation_answer("main")
        assert isinstance(result, str)

    def test_symbol_resolutions(self):
        from arforge.symbol_resolver import build_symbol_resolutions, list_symbol_resolutions
        r = build_symbol_resolutions()
        assert r["success"]
        symbols = list_symbol_resolutions(10)
        assert isinstance(symbols, list)
