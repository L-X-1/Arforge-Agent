from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from arforge.lsp_runtime import LSPManager, LSPRuntimeError, ServerSpec


FAKE_SERVER = Path(__file__).parent / "fixtures" / "fake_lsp_server.py"


def _manager(root: Path) -> LSPManager:
    return LSPManager(
        root,
        (
            ServerSpec(
                "python",
                (".py",),
                ((sys.executable, str(FAKE_SERVER)),),
            ),
        ),
    )


def test_real_stdio_protocol_supports_navigation_hover_calls_and_diagnostics(tmp_path):
    source = tmp_path / "sample.py"
    source.write_text(
        "def target():\n    return 1\n\n"
        "target()\n",
        encoding="utf-8",
    )
    manager = _manager(tmp_path)
    try:
        definition = manager.query("goToDefinition", source, 1, 6)
        references = manager.query("findReferences", source, 1, 6)
        hover = manager.query("hover", source, 1, 6)
        incoming = manager.query("incomingCalls", source, 1, 6)
        outgoing = manager.query("outgoingCalls", source, 1, 6)
        diagnostics = manager.query("diagnostics", source, 1, 1)
    finally:
        manager.close()

    assert definition["backend"] == "language-server"
    assert definition["result"]["file"] == "sample.py"
    assert definition["result"]["range"]["start"] == {"line": 1, "character": 5}
    assert references["result_count"] == 2
    assert hover["result"]["contents"]["value"] == "`target() -> int`"
    assert incoming["result"][0]["from"]["name"] == "caller"
    assert outgoing["result"][0]["to"]["name"] == "callee"
    assert diagnostics["result"][0]["message"] == "test diagnostic"
    assert diagnostics["result"][0]["range"]["start"]["line"] == 1


def test_missing_server_falls_back_to_existing_index_and_compile_diagnostics(tmp_path):
    source = tmp_path / "sample.py"
    source.write_text(
        "def target():\n"
        "    return (\n\n"
        "target()\n",
        encoding="utf-8",
    )
    manager = LSPManager(
        tmp_path,
        (
            ServerSpec(
                "python",
                (".py",),
                (("arforge-language-server-that-does-not-exist",),),
            ),
        ),
    )

    definition = manager.query("goToDefinition", source, 1, 6)
    references = manager.query("findReferences", source, 4, 3)
    diagnostics = manager.query("diagnostics", source, 1, 1)

    assert definition["backend"] == "index-fallback"
    assert definition["result"][0]["name"] == "target"
    assert references["result_count"] == 2
    assert references["result"][0]["range"]["start"]["line"] == 1
    assert diagnostics["result"][0]["source"] == "python-compile"
    assert diagnostics["result"][0]["range"]["start"]["line"] >= 1


def test_workspace_and_position_boundaries_fail_closed(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    source = root / "sample.py"
    source.write_text("value = 1\n", encoding="utf-8")
    outside = tmp_path / "outside.py"
    outside.write_text("value = 2\n", encoding="utf-8")
    manager = _manager(root)

    with pytest.raises(LSPRuntimeError, match="outside"):
        manager.query("hover", outside, 1, 1)
    with pytest.raises(LSPRuntimeError, match="line"):
        manager.query("hover", source, 2, 1)
    with pytest.raises(LSPRuntimeError, match="character"):
        manager.query("hover", source, 1, 100)
    with pytest.raises(LSPRuntimeError, match="unsupported"):
        manager.query("rename", source, 1, 1)


def test_python_builtin_registry_does_not_register_legacy_lsp_tools():
    """The TypeScript lsp tool is the only default product owner."""

    from arforge.tools import BUILTIN_TOOL_MODULES

    assert "arforge.tools.lsp_tools" not in BUILTIN_TOOL_MODULES


def test_legacy_lsp_module_remains_explicitly_importable(monkeypatch, tmp_path):
    """Old Python callers keep an opt-in compatibility seam during migration."""

    from arforge.tool_executor import execute_tool_by_name
    from arforge.tool_registry import REGISTRY
    from arforge.tools import file_tools, lsp_tools

    source = tmp_path / "sample.py"
    source.write_text("def target():\n    return 1\n", encoding="utf-8")
    file_tools.set_workspace(tmp_path)
    manager = _manager(tmp_path)
    monkeypatch.setattr(lsp_tools, "get_lsp_manager", lambda _root: manager)

    try:
        schema = next(
            item for item in REGISTRY.to_openai_tools()
            if item["function"]["name"] == "language_service"
        )
        operation_schema = schema["function"]["parameters"]["properties"]["operation"]
        assert "goToDefinition" in operation_schema["enum"]
        assert "diagnostics" in operation_schema["enum"]

        result = execute_tool_by_name(
            "language_service",
            {
                "operation": "goToDefinition",
                "filename": "sample.py",
                "line": 1,
                "character": 6,
            },
        )
    finally:
        manager.close()

    assert result.success
    payload = json.loads(result.output)
    assert payload["backend"] == "language-server"
    assert payload["result"]["file"] == "sample.py"
    assert REGISTRY.get("language_service_status") is not None


def test_status_reports_executable_name_without_arguments(tmp_path):
    manager = _manager(tmp_path)
    item = manager.server_status()["items"][0]

    assert item["available"] is True
    assert item["command"] == sys.executable
    assert str(FAKE_SERVER) not in json.dumps(item)
