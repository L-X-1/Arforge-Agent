def test_capability_pipeline_and_cli():
    from arforge.capability.benchmark import benchmark_capability_router
    from arforge.capability.capability_cli import capability_status
    from arforge.capability.capability_db import capability_db_status
    from arforge.capability.enhanced_pipeline import run_enhanced_pipeline

    assert capability_db_status()["success"]
    assert "planning" in capability_status()
    assert benchmark_capability_router()["samples"] > 0
    assert "results" in run_enhanced_pipeline("plan this")


def test_tool_facades_and_perception():
    from arforge.tools.code_tools import list_code_files
    from arforge.tools.context_tools import list_variable_types
    from arforge.tools.infra_tools import list_config_files
    from arforge.tools.mcp_tools import list_tools
    from arforge.tools.perception_tools import run_incremental_perception_quick

    assert list_code_files()
    assert isinstance(list_variable_types(), list)
    assert "pyproject.toml" in list_config_files()
    assert list_tools()
    assert run_incremental_perception_quick()["files"] > 0


def test_web_and_data_tools(tmp_path):
    from arforge.tools.data_tools import read_csv_preview, summarize_rows
    from arforge.tools.web_tools import extract_links, html_to_text

    csv_path = tmp_path / "sample.csv"
    csv_path.write_text("a,b\n1,2\n", encoding="utf-8")
    rows = read_csv_preview(str(csv_path))

    assert html_to_text("<p>Hello</p>") == "Hello"
    assert extract_links('<a href="x">x</a>') == ["x"]
    assert rows[0]["a"] == "1"
    assert summarize_rows(rows)["columns"] == ["a", "b"]
