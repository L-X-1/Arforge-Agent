from __future__ import annotations

import importlib
import sys

import pytest

from arforge.core.cross_file_consistency import (
    analyze_symbol_change,
    apply_python_symbol_rename,
    format_python_symbol_rename,
    format_symbol_change_plan,
)


def test_symbol_change_plan_finds_defs_imports_references_and_calls(tmp_path):
    (tmp_path / "service.py").write_text(
        "def process_order(order, *, retry=False):\n"
        "    return order\n",
        encoding="utf-8",
    )
    (tmp_path / "consumer.py").write_text(
        "from service import process_order\n\n"
        "def run(order):\n"
        "    return process_order(order, retry=True)\n",
        encoding="utf-8",
    )
    (tmp_path / "client.py").write_text(
        "import service\n\n"
        "def run(order):\n"
        "    return service.process_order(order)\n",
        encoding="utf-8",
    )

    plan = analyze_symbol_change(
        "process_order",
        root=tmp_path,
        new_name="submit_order",
        signature="def submit_order(order, *, retry=False, timeout=None)",
    )

    assert plan["operations"] == [
        "rename_definitions",
        "rename_references",
        "update_imports",
        "update_signature",
        "review_call_sites",
    ]
    assert set(plan["affected_files"]) == {"client.py", "consumer.py", "service.py"}
    assert plan["summary"]["definitions"] == 1
    assert plan["summary"]["imports"] == 1
    assert plan["summary"]["call_sites"] == 2
    assert any(item["file"] == "consumer.py" and item["kwargs"] == ["retry"] for item in plan["call_sites"])
    assert any(item["file"] == "client.py" and item["name"] == "service.process_order" for item in plan["call_sites"])
    assert any("Import statements" in warning for warning in plan["warnings"])


def test_symbol_change_plan_warns_when_definition_missing(tmp_path):
    (tmp_path / "consumer.py").write_text(
        "def run(value):\n"
        "    return missing_symbol(value)\n",
        encoding="utf-8",
    )

    plan = analyze_symbol_change("missing_symbol", root=tmp_path)

    assert plan["summary"]["definitions"] == 0
    assert plan["summary"]["call_sites"] == 1
    assert any("No definition" in warning for warning in plan["warnings"])


def test_format_symbol_change_plan_is_stable(tmp_path):
    (tmp_path / "service.py").write_text(
        "def process_order(order):\n"
        "    return order\n",
        encoding="utf-8",
    )
    plan = analyze_symbol_change("process_order", root=tmp_path, new_name="submit_order")

    output = format_symbol_change_plan(plan)

    assert "Cross-file consistency plan" in output
    assert "rename_to: submit_order" in output
    assert "service.py" in output


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_WORKSPACE", str(tmp_path))
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools") or mod.startswith("arforge.tools.code_tools"):
            del sys.modules[mod]
    import arforge.tools.file_tools
    import arforge.tools.code_tools

    importlib.reload(arforge.tools.file_tools)
    importlib.reload(arforge.tools.code_tools)
    return tmp_path


def test_code_consistency_plan_tool_is_registered_read_only(workspace):
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("code_consistency_plan")

    assert tool is not None
    assert tool.schema.risk_level == "low"
    assert tool.schema.requires_confirmation is False
    assert tool.schema.category == "read"


def test_code_consistency_plan_tool_uses_workspace(workspace):
    from arforge.tool_registry import REGISTRY

    (workspace / "service.py").write_text(
        "def process_order(order):\n"
        "    return order\n",
        encoding="utf-8",
    )
    (workspace / "consumer.py").write_text(
        "from service import process_order\n"
        "result = process_order('demo')\n",
        encoding="utf-8",
    )

    result = REGISTRY.execute_by_name(
        "code_consistency_plan",
        {"symbol": "process_order", "new_name": "submit_order"},
    )

    assert result.success, result.error
    assert "affected_files: 2" in result.output
    assert "consumer.py" in result.output
    assert "Imports to review" in result.output


def test_python_symbol_rename_dry_run_does_not_write(tmp_path):
    service = tmp_path / "service.py"
    service.write_text(
        "def process_order(order):\n"
        "    note = 'process_order should stay in strings'\n"
        "    return order\n",
        encoding="utf-8",
    )

    result = apply_python_symbol_rename("process_order", "submit_order", root=tmp_path)

    assert result["applied"] is False
    assert result["total_replacements"] == 1
    assert "def process_order" in service.read_text(encoding="utf-8")
    assert "Dry-run only" in "\n".join(result["warnings"])


def test_python_symbol_rename_apply_updates_defs_imports_and_calls(tmp_path):
    (tmp_path / "service.py").write_text(
        "def process_order(order):\n"
        "    return order\n",
        encoding="utf-8",
    )
    (tmp_path / "consumer.py").write_text(
        "from service import process_order\n"
        "result = process_order('demo')\n",
        encoding="utf-8",
    )
    (tmp_path / "client.py").write_text(
        "import service\n"
        "result = service.process_order('demo')\n",
        encoding="utf-8",
    )

    result = apply_python_symbol_rename("process_order", "submit_order", root=tmp_path, apply=True)
    output = format_python_symbol_rename(result)

    assert result["applied"] is True
    assert result["total_replacements"] == 4
    assert "Python symbol rename applied" in output
    assert "def submit_order" in (tmp_path / "service.py").read_text(encoding="utf-8")
    assert "import submit_order" in (tmp_path / "consumer.py").read_text(encoding="utf-8")
    assert "submit_order('demo')" in (tmp_path / "consumer.py").read_text(encoding="utf-8")
    assert "service.submit_order" in (tmp_path / "client.py").read_text(encoding="utf-8")


def test_python_symbol_rename_does_not_touch_strings_or_comments(tmp_path):
    target = tmp_path / "service.py"
    target.write_text(
        "# process_order comment remains\n"
        "def process_order(order):\n"
        "    return 'process_order literal'\n",
        encoding="utf-8",
    )

    apply_python_symbol_rename("process_order", "submit_order", root=tmp_path, apply=True)
    text = target.read_text(encoding="utf-8")

    assert "def submit_order" in text
    assert "# process_order comment remains" in text
    assert "'process_order literal'" in text


def test_python_symbol_rename_rejects_invalid_or_missing_definition(tmp_path):
    (tmp_path / "consumer.py").write_text("result = missing_symbol('demo')\n", encoding="utf-8")

    with pytest.raises(ValueError, match="valid Python identifier"):
        apply_python_symbol_rename("missing_symbol", "not-valid", root=tmp_path)
    with pytest.raises(ValueError, match="definition not found"):
        apply_python_symbol_rename("missing_symbol", "present_symbol", root=tmp_path)


def test_python_symbol_rename_tool_dry_run_is_available_without_global_confirmation(workspace):
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("python_symbol_rename")

    assert tool is not None
    assert tool.schema.risk_level == "low"
    assert tool.schema.requires_confirmation is False
    assert tool.schema.category == "workspace_write"
