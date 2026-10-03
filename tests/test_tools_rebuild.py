from pathlib import Path


def test_tool_registry_and_calculate():
    from arforge.tool_executor import execute_tool_by_name, list_tools

    result = execute_tool_by_name("calculate", {"expression": "2 + 3 * 4"})
    assert result.success
    assert result.output == "14"
    assert any(tool["name"] == "calculate" for tool in list_tools())


def test_file_tools_are_workspace_scoped(monkeypatch):
    from arforge.tools.file_tools import read_file, write_file

    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    result = write_file("tool_test.txt", "hello")
    assert "wrote" in result
    assert read_file("tool_test.txt") == "hello"


def test_source_read_tools_preserve_complete_single_file_apps():
    import arforge.tools.code_tools  # noqa: F401 - registers the tool surface
    import arforge.tools.file_tools  # noqa: F401 - registers the tool surface
    from arforge.tool_registry import REGISTRY

    assert REGISTRY.get("read_file").schema.output_limit == 60_000
    assert REGISTRY.get("code_read").schema.output_limit == 60_000


def test_task_tools_create_and_complete():
    from arforge.tools.task_tools import complete_task, create_task, delete_task

    task = create_task("rebuild tool layer", priority="high", tag="test")

    assert task["id"]
    assert complete_task(task["id"])["status"] == "completed"
    assert delete_task(task["id"])


def test_tool_executor_match():
    from arforge.tool_executor import run_tool_if_match

    result = run_tool_if_match("calculate 1+1")

    assert result is not None
    assert result.success


def test_obsolete_singular_test_runner_wrapper_is_retired():
    root = Path(__file__).resolve().parents[1]
    assert not (root / "arforge" / "tools" / "test_runner_tool.py").exists()

    from arforge.tools import BUILTIN_TOOL_MODULES

    assert "arforge.tools.test_runner_tools" in BUILTIN_TOOL_MODULES
    assert "arforge.tools.test_runner_tool" not in BUILTIN_TOOL_MODULES


def test_symbol_tool_has_one_default_owner_and_keeps_legacy_import():
    """The old module is an import seam, never a second registry owner."""

    import arforge.tools.code_tools as canonical
    import arforge.tools.symbol_tools as compatibility
    from arforge.tool_registry import REGISTRY
    from arforge.tools import BUILTIN_TOOL_MODULES

    assert "arforge.tools.symbol_tools" not in BUILTIN_TOOL_MODULES
    assert compatibility.code_symbols is canonical.code_symbols
    assert REGISTRY.get("code_symbols") is not None
    assert REGISTRY.get("code_symbols").source == canonical.__name__


def test_mcp_client_tools_have_one_default_owner_and_keep_legacy_import():
    """The legacy Python MCP wrappers are explicit compatibility only."""

    import arforge.tools.mcp_client_tools as compatibility
    from arforge.tool_registry import REGISTRY
    from arforge.tools import BUILTIN_TOOL_MODULES

    assert "arforge.tools.mcp_client_tools" not in BUILTIN_TOOL_MODULES
    for name in (
        "mcp_client_servers",
        "mcp_resource_list",
        "mcp_resource_read",
        "mcp_tools_refresh",
    ):
        tool = REGISTRY.get(name)
        assert tool is not None
        assert tool.source == compatibility.__name__


def test_office_tools_are_explicit_compatibility_only():
    """TS/Core owns Office writes; Python wrappers require an explicit import."""

    from arforge.tools import BUILTIN_TOOL_MODULES

    assert "arforge.tools.office_tools" not in BUILTIN_TOOL_MODULES

    import arforge.tools.office_tools as compatibility
    from arforge.tool_registry import REGISTRY

    for name in ("write_docx", "write_xlsx", "write_pptx", "write_pdf", "read_office_document"):
        tool = REGISTRY.get(name)
        assert tool is not None
        assert tool.source in {compatibility.__name__, "arforge.tools.file_tools"}


def test_frontend_and_javascript_validators_have_one_ts_core_owner():
    """Legacy Python names remain importable but are never default owners."""

    from arforge.tools import BUILTIN_TOOL_MODULES

    assert "arforge.tools.frontend_tools" not in BUILTIN_TOOL_MODULES
    assert "arforge.tools.js_tools" not in BUILTIN_TOOL_MODULES

    import arforge.tools.frontend_tools as frontend_compatibility
    import arforge.tools.js_tools as javascript_compatibility
    from arforge.tool_registry import REGISTRY

    frontend = REGISTRY.get("validate_frontend")
    javascript = REGISTRY.get("validate_js")
    assert frontend is not None and frontend.source == frontend_compatibility.__name__
    assert javascript is not None and javascript.source == javascript_compatibility.__name__


def test_asset_localization_is_explicit_until_the_safe_ts_pipeline_exists():
    """Unsafe direct CDN writes never enter the default Python bootstrap."""

    from arforge.tools import BUILTIN_TOOL_MODULES

    assert "arforge.tools.asset_tools" not in BUILTIN_TOOL_MODULES

    import arforge.tools.asset_tools as compatibility
    from arforge.tool_registry import REGISTRY

    for name in ("download_asset", "download_all_cdn"):
        tool = REGISTRY.get(name)
        assert tool is not None and tool.source == compatibility.__name__


def test_task_graph_python_wrapper_is_explicit_and_ts_owned():
    """TaskGraphV2 is the only product owner; Python remains opt-in."""

    from arforge.tools import (
        BUILTIN_TOOL_MODULES,
        COMPATIBILITY_TOOL_MODULES,
        load_compatibility_tools,
    )

    assert "arforge.tools.task_tools" not in BUILTIN_TOOL_MODULES
    assert "arforge.tools.task_tools" in COMPATIBILITY_TOOL_MODULES

    import arforge.tools.task_tools as compatibility
    from arforge.tool_registry import REGISTRY

    assert load_compatibility_tools() == {}
    for name in (
        "create_task",
        "list_tasks",
        "search_tasks",
        "update_task",
        "claim_task",
        "complete_task",
        "cancel_task",
        "delete_task",
    ):
        tool = REGISTRY.get(name)
        assert tool is not None and tool.source == compatibility.__name__
