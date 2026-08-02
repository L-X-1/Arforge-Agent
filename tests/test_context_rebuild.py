def test_project_scanner_and_code_indexer_find_python_files():
    from arforge.code_indexer import index_project, list_code_files, search_code
    from arforge.project_scanner import build_project_tree

    assert index_project()["files"] > 0
    assert any(path.endswith("cli.py") for path in list_code_files())
    assert "arforge" in build_project_tree(max_files=20)
    assert search_code("Arforge", limit=3)


def test_project_scanner_prunes_generated_directories(tmp_path):
    from arforge.project_scanner import scan_project

    source = tmp_path / "src"
    source.mkdir()
    (source / "kept.py").write_text("VALUE = 1", encoding="utf-8")
    for excluded in ("node_modules", "target", ".pytest-tmp"):
        generated = tmp_path / excluded
        generated.mkdir()
        (generated / "ignored.py").write_text("VALUE = 2", encoding="utf-8")

    paths = {item["path"].replace("\\", "/") for item in scan_project(tmp_path)}

    assert paths == {"src/kept.py"}


def test_python_ast_indexer_finds_symbols():
    from arforge.python_ast_indexer import goto_symbol, index_python_ast

    assert index_python_ast()["symbols"] > 0
    symbol = goto_symbol("ArforgeAgent")

    assert symbol is not None
    assert symbol["file"].endswith("agent_core.py")


def test_context_builder_returns_retrieved_context():
    from arforge.context_builder import build_coding_context, build_context

    context = build_context("system", "memory", [{"role": "user", "content": "hi"}], "now")
    coding = build_coding_context("ArforgeAgent")

    assert "Current request: now" in context
    assert "Project tree:" in coding
