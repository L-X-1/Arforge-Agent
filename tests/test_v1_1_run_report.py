"""v1-1.1 结构化任务报告（run_report）测试。"""

from __future__ import annotations

import pytest

from arforge.core.change_tracker import get_change_tracker, reset_change_tracker
from arforge.core.hooks import HookContext, HookEvent, get_hook_manager, reset_hook_manager
from arforge.core.run_report import (
    RunReport,
    get_run_report,
    install_run_report_hook,
    reset_run_report,
    run_report_scope,
)
from arforge.tool_registry import ToolResult
from arforge.workspace_context import execution_scope


@pytest.fixture(autouse=True)
def _iso():
    reset_run_report()
    reset_change_tracker()
    yield
    reset_run_report()
    reset_change_tracker()


def _res(name, ok=True, output="ok"):
    return ToolResult(name, ok, output)


def test_records_explored_dedup():
    r = RunReport()
    r.record_tool("read_file", {"filename": "a.py"}, _res("read_file"))
    r.record_tool("code_read", {"filename": "b.py"}, _res("code_read"))
    r.record_tool("read_file", {"filename": "a.py"}, _res("read_file"))
    assert r.to_dict()["explored_files"] == ["a.py", "b.py"]


def test_records_commands_with_status():
    r = RunReport()
    r.record_tool("run_cmd", {"command": "pytest"}, _res("run_cmd", ok=True))
    r.record_tool("run_cmd", {"command": "ls"}, _res("run_cmd", ok=False))
    assert r.to_dict()["commands_run"] == [
        {"command": "pytest", "success": True},
        {"command": "ls", "success": False},
    ]


def test_records_verifications():
    r = RunReport()
    r.record_tool("verify_work", {}, _res("verify_work", output="✔ 全部通过\n改动文件:x"))
    assert "全部通过" in r.to_dict()["verifications"][0]


def test_modified_from_change_tracker():
    get_change_tracker().record("c.py")
    assert "c.py" in get_run_report().to_dict()["modified_files"]


def test_render_contains_sections():
    r = RunReport()
    r.record_tool("read_file", {"filename": "a.py"}, _res("read_file"))
    r.record_tool("run_cmd", {"command": "pytest"}, _res("run_cmd"))
    r.set_final_answer("done")
    text = r.render()
    assert "探索文件" in text
    assert "执行命令" in text
    assert "pytest" in text


def test_to_dict_structure():
    d = RunReport().to_dict()
    assert set(d) >= {
        "explored_files",
        "modified_files",
        "commands_run",
        "verifications",
        "tool_calls",
        "final_answer",
    }


def test_singleton_reset():
    get_run_report().record_tool("read_file", {"filename": "x.py"}, _res("read_file"))
    assert get_run_report().to_dict()["explored_files"]
    reset_run_report()
    assert not get_run_report().to_dict()["explored_files"]


def test_report_scope_isolates_nested_execution_and_restores_parent():
    get_run_report().record_tool("read_file", {"filename": "parent.py"}, _res("read_file"))

    with run_report_scope():
        get_run_report().record_tool("read_file", {"filename": "child.py"}, _res("read_file"))
        assert get_run_report().to_dict()["explored_files"] == ["child.py"]

    assert get_run_report().to_dict()["explored_files"] == ["parent.py"]


def test_execution_scope_keeps_reports_separate_between_sessions():
    with execution_scope("session-a"):
        get_run_report().record_tool("read_file", {"filename": "a.py"}, _res("read_file"))
        with execution_scope("session-b"):
            get_run_report().record_tool("read_file", {"filename": "b.py"}, _res("read_file"))
            assert get_run_report().to_dict()["explored_files"] == ["b.py"]
        assert get_run_report().to_dict()["explored_files"] == ["a.py"]


def test_empty_render():
    assert "无文件" in RunReport().render()


def test_install_hook_records():
    reset_hook_manager()
    reset_run_report()
    install_run_report_hook()
    ctx = HookContext(
        HookEvent.POST_TOOL_USE,
        tool_name="read_file",
        tool_args={"filename": "z.py"},
        tool_result=_res("read_file"),
    )
    get_hook_manager().fire(ctx)
    assert "z.py" in get_run_report().to_dict()["explored_files"]


def test_install_hook_is_idempotent_for_command_reporting():
    reset_hook_manager()
    reset_run_report()
    install_run_report_hook()
    install_run_report_hook()
    get_hook_manager().fire(
        HookContext(
            HookEvent.POST_TOOL_USE,
            tool_name="run_cmd",
            tool_args={"command": "pytest -q"},
            tool_result=_res("run_cmd"),
        )
    )
    assert get_run_report().to_dict()["commands_run"] == [
        {"command": "pytest -q", "success": True}
    ]
