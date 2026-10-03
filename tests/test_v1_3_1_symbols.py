"""v1-3.1 多语言符号索引（symbol_index）测试。"""

from __future__ import annotations

import pytest

from arforge.core.symbol_index import (
    extract_symbols,
    extract_symbols_from_file,
    language_for,
    tree_sitter_available,
)

pytestmark = pytest.mark.skipif(
    not tree_sitter_available(), reason="tree-sitter not installed"
)


# -- language_for -------------------------------------------------------------


def test_language_for():
    assert language_for("a.js") == "javascript"
    assert language_for("a.tsx") == "typescript"
    assert language_for("a.go") == "go"
    assert language_for("a.rs") == "rust"
    assert language_for("a.py") is None  # Python 走 AST，不归 tree-sitter
    assert language_for("a.txt") is None


# -- JS / TS / Go 符号提取（真实 tree-sitter 解析）---------------------------


def test_extract_js_symbols():
    src = "function foo(a){return a}\nclass Bar{ baz(){} }\nconst qux = () => 1\n"
    syms = extract_symbols(src, "javascript")
    names = {s["name"]: s["type"] for s in syms}
    assert names.get("foo") == "function"
    assert names.get("Bar") == "class"
    assert names.get("baz") == "method"
    assert "qux" in names  # const-arrow


def test_extract_ts_symbols():
    src = "interface I{x:number}\ntype T = string\nfunction f(a){return a}\nclass C{ m(){} }\n"
    syms = extract_symbols(src, "typescript")
    names = {s["name"]: s["type"] for s in syms}
    assert names.get("I") == "interface"
    assert names.get("T") == "type"
    assert names.get("f") == "function"
    assert names.get("C") == "class"
    assert names.get("m") == "method"


def test_extract_go_symbols():
    src = "package main\nfunc Foo(a int) int { return a }\ntype T struct{}\nfunc (t T) Bar() {}\n"
    syms = extract_symbols(src, "go")
    names = {s["name"]: s["type"] for s in syms}
    assert names.get("Foo") == "function"
    assert names.get("Bar") == "method"
    assert names.get("T") == "type"


def test_extract_rust_advanced_symbols():
    src = """
pub mod data {
    use crate::{model::Task, Result as AppResult};
    macro_rules! make_id { ($name:ident) => { struct $name(u64); }; }
    pub union Bits { pub int: u32, pub float: f32 }
    pub enum State { Ready, Failed { code: i32 } }
    pub trait Repository<T>: Send where T: Clone {
        type Error: std::error::Error;
        const VERSION: u32;
        fn get<'a>(&'a self, id: u64) -> AppResult<&'a T>;
    }
    pub struct Store<T> { pub value: T }
    impl<T> Repository<T> for Store<T> where T: Clone + Send {
        type Error = std::io::Error;
        const VERSION: u32 = 1;
        async fn get<'a>(&'a self, _id: u64) -> AppResult<&'a T> { todo!() }
    }
    impl<T> Store<T> { pub fn new(value: T) -> Self { Self { value } } }
    extern "C" { pub fn native_call(value: i32) -> i32; }
    make_id!(TaskId);
}
"""
    symbols = extract_symbols(src, "rust")

    def one(name, kind):
        return next(symbol for symbol in symbols if symbol["name"] == name and symbol["type"] == kind)

    assert one("data", "module")["visibility"] == "pub"
    assert one("Task", "import")["import_path"] == "crate::model::Task"
    app_result = one("AppResult", "import")
    assert app_result["alias"] == "AppResult"
    assert app_result["import_path"] == "crate::Result"
    assert "{model::Task, Result as AppResult}" in app_result["signature"]
    assert one("make_id", "macro")["qualified_name"] == "data::make_id"
    assert one("Bits", "union")["visibility"] == "pub"
    assert one("int", "field")["qualified_name"] == "data::Bits::int"
    assert one("Ready", "variant")["qualified_name"] == "data::State::Ready"
    assert one("code", "field")["qualified_name"] == "data::State::Failed::code"

    trait = one("Repository", "trait")
    assert trait["generics"] == "<T>"
    assert trait["where_clause"] == "where T: Clone"
    assert trait["bounds"] == ": Send"
    trait_method = next(
        symbol for symbol in symbols
        if symbol["qualified_name"] == "data::Repository::get"
    )
    assert trait_method["type"] == "method"
    assert trait_method["visibility"] == "trait"
    assert trait_method["parameters"] == "(&'a self, id: u64)"
    assert trait_method["return_type"] == "AppResult<&'a T>"

    implementation = one("Repository<T> for Store<T>", "impl")
    assert implementation["trait"] == "Repository<T>"
    assert implementation["impl_target"] == "Store<T>"
    assert implementation["where_clause"] == "where T: Clone + Send"
    assert "{" not in implementation["signature"]
    assert any(
        symbol["type"] == "associated_type"
        and symbol["qualified_name"].endswith("::Error")
        and symbol.get("value_type") == "std::io::Error"
        for symbol in symbols
    )
    assert any(
        symbol["type"] == "associated_const"
        and symbol["qualified_name"].endswith("::VERSION")
        for symbol in symbols
    )
    assert one("new", "method")["qualified_name"] == "data::impl Store<T>::new"
    assert one("native_call", "foreign_function")["return_type"] == "i32"
    macro_call = one("make_id", "macro_call")
    assert macro_call["is_reference"] is True


def test_extract_rust_nested_reexports_and_wildcards():
    symbols = extract_symbols(
        "pub use super::api::{self, client::{Client, Config as ClientConfig}, *};",
        "rust",
    )
    imports = {symbol["name"]: symbol for symbol in symbols}
    assert imports["api"]["import_path"] == "super::api"
    assert imports["Client"]["import_path"] == "super::api::client::Client"
    assert imports["ClientConfig"]["import_path"] == "super::api::client::Config"
    assert imports["ClientConfig"]["alias"] == "ClientConfig"
    assert imports["*"]["import_path"] == "super::api::*"
    assert all(symbol["is_reexport"] is True for symbol in symbols)


def test_symbols_sorted_by_line():
    src = "function a(){}\nfunction b(){}\nfunction c(){}\n"
    lines = [s["line"] for s in extract_symbols(src, "javascript")]
    assert lines == sorted(lines)


def test_extract_unknown_language_empty():
    assert extract_symbols("x = 1", "python") == []  # 不在 tree-sitter 支持集


def test_extract_from_file(tmp_path):
    f = tmp_path / "mod.ts"
    f.write_text("export function hello(){}\nclass Widget{ render(){} }\n", encoding="utf-8")
    syms = extract_symbols_from_file(f)
    names = {s["name"] for s in syms}
    assert "hello" in names
    assert "Widget" in names
    assert "render" in names


def test_extract_from_unsupported_file(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("nothing", encoding="utf-8")
    assert extract_symbols_from_file(f) == []


# -- code_symbols 工具 --------------------------------------------------------


def test_code_symbols_tool_js(tmp_path, monkeypatch):
    import arforge.tools.symbol_tools as symbol_tools  # noqa: F401  兼容导入
    from arforge.tool_registry import REGISTRY

    import arforge.tools.code_tools as code_tools

    assert symbol_tools.code_symbols is code_tools.code_symbols
    assert REGISTRY.get("code_symbols").source == code_tools.__name__

    f = tmp_path / "app.js"
    f.write_text("function main(){}\nclass App{ run(){} }\n", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: f)
    res = REGISTRY.execute_by_name("code_symbols", {"filename": "app.js"})
    assert res.success, res.error
    assert "main" in res.output
    assert "App" in res.output
    assert "run" in res.output
