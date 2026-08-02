from __future__ import annotations

import pytest

from arforge.core.change_tracker import (
    ChangeTracker,
    get_change_tracker,
    install_change_tracker_hook,
    record_change_hook,
    reset_change_tracker,
)
from arforge.core.hooks import HookContext, HookEvent, get_hook_manager, reset_hook_manager
from arforge.tool_registry import REGISTRY, ToolResult
from arforge.models.model_adapter import ToolCallResponse
from arforge.core.agentic import run_tool_loop


@pytest.fixture(autouse=True)
def _isolate():
    reset_change_tracker()
    yield
    reset_change_tracker()


def test_record_dedup_and_order():
    tracker = ChangeTracker()
    tracker.record("a.py")
    tracker.record("b.py")
    tracker.record("a.py")
    assert tracker.changed() == ["a.py", "b.py"]


def test_record_ignores_empty():
    tracker = ChangeTracker()
    tracker.record("")
    tracker.record(None)
    assert tracker.is_empty()


def test_singleton_and_reset():
    assert get_change_tracker() is get_change_tracker()
    get_change_tracker().record("x.py")
    reset_change_tracker()
    assert get_change_tracker().is_empty()


def _ctx(tool: str, filename: str, success: bool = True):
    return HookContext(
        HookEvent.POST_TOOL_USE,
        tool_name=tool,
        tool_args={"filename": filename},
        tool_result=ToolResult(tool, success, "ok" if success else ""),
    )


def test_hook_records_write_tools():
    record_change_hook(_ctx("write_file", "a.py"))
    record_change_hook(_ctx("edit_file", "b.py"))
    record_change_hook(_ctx("create_file", "c.py"))
    record_change_hook(_ctx("delete_file", "old.py"))
    assert get_change_tracker().changed() == ["a.py", "b.py", "c.py", "old.py"]


def test_hook_ignores_failed_and_nonwrite():
    record_change_hook(_ctx("write_file", "fail.py", success=False))
    record_change_hook(_ctx("read_file", "r.py"))
    assert get_change_tracker().is_empty()


def test_verify_work_no_changes():
    import arforge.tools.verify_tools  # noqa: F401

    result = REGISTRY.execute_by_name("verify_work", {})
    assert result.success
    assert "no changed files" in result.output


def test_verify_work_all_pass(tmp_path, monkeypatch):
    import arforge.tools.verify_tools  # noqa: F401

    (tmp_path / "a.py").write_text("x = 1\n", encoding="utf-8")
    get_change_tracker().record("a.py")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda filename: tmp_path / filename)

    result = REGISTRY.execute_by_name("verify_work", {})

    assert result.success
    assert "All syntax/format checks passed" in result.output
    assert "G12 quality gate" in result.output
    assert "a.py" in result.output


def test_verify_work_flags_problem(tmp_path, monkeypatch):
    import arforge.tools.verify_tools  # noqa: F401

    (tmp_path / "bad.py").write_text("def f(:\n", encoding="utf-8")
    (tmp_path / "ok.py").write_text("y = 2\n", encoding="utf-8")
    get_change_tracker().record("ok.py")
    get_change_tracker().record("bad.py")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda filename: tmp_path / filename)

    result = REGISTRY.execute_by_name("verify_work", {})

    assert result.success
    assert "Syntax/format problems" in result.output
    assert "bad.py" in result.output


def test_verify_work_reports_intentional_deletion_without_syntax_failure(tmp_path, monkeypatch):
    import arforge.tools.verify_tools  # noqa: F401

    get_change_tracker().record("removed-debug.php")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda filename: tmp_path / filename)

    result = REGISTRY.execute_by_name("verify_work", {})

    assert result.success
    assert "Deleted files: removed-debug.php" in result.output
    assert "Syntax/format problems" not in result.output


def test_install_registers_hook():
    reset_hook_manager()
    install_change_tracker_hook()
    names = [entry.name for entry in get_hook_manager()._handlers.get(HookEvent.POST_TOOL_USE, [])]
    assert "change_tracker" in names


def test_install_then_fire_records():
    reset_hook_manager()
    reset_change_tracker()
    install_change_tracker_hook()
    get_hook_manager().fire(_ctx("write_file", "z.py"))
    assert "z.py" in get_change_tracker().changed()


def test_main_agent_run_installs_change_tracking_hook(monkeypatch):
    """The primary AgentRun must track writes, not only sub-agent runs."""
    from types import SimpleNamespace

    from arforge.core.agent_run import AgentRun

    reset_hook_manager()
    monkeypatch.setattr(
        "arforge.core.agent_loop_v2.AgentLoopV2.run_agentic",
        lambda self, **kwargs: SimpleNamespace(
            answer="done",
            intent="general",
            tool_calls=[],
            trace=[],
            steps=0,
            messages=[],
            verifications=[],
            incomplete_report=None,
            observability=None,
        ),
    )
    monkeypatch.setattr("arforge.core.agent_run.persist_run_transaction", lambda run_id: None)
    monkeypatch.setattr("arforge.core.agent_run.save_run_messages", lambda run_id, messages: None)

    AgentRun(user_input="test").execute()

    names = get_hook_manager().handler_names(HookEvent.POST_TOOL_USE)
    assert "change_tracker" in names


def test_direct_tool_loop_installs_change_tracking_hook():
    class FinalAdapter:
        model_name = "test"

        def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kwargs):
            return ToolCallResponse(content="done", finish_reason="stop", tool_calls=[])

    reset_hook_manager()

    run_tool_loop(
        FinalAdapter(),
        [{"role": "user", "content": "read-only answer"}],
        tools=[],
        max_steps=1,
    )

    names = get_hook_manager().handler_names(HookEvent.POST_TOOL_USE)
    assert "change_tracker" in names
