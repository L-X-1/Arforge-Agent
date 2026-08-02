"""G5 子代理编排（subagent + spawn_subagent）测试。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from arforge.core import subagent
from arforge.tool_registry import REGISTRY


class _FakeAdapter:
    """最小 adapter：按脚本返回 ToolCallResponse 样式对象。"""

    model_name = "fake"

    def __init__(self, script):
        self._script = list(script)  # [(content, tool_calls), ...]
        self.calls = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto"):
        content, tool_calls = self._script[min(self.calls, len(self._script) - 1)]
        self.calls += 1
        return SimpleNamespace(content=content, tool_calls=tool_calls, usage={})


@pytest.fixture(autouse=True)
def _isolate():
    subagent.clear_subagent_adapter()
    yield
    subagent.clear_subagent_adapter()


# -- run_subagent -------------------------------------------------------------


def test_no_adapter_returns_unavailable():
    assert "不可用" in subagent.run_subagent("探索 X")


def test_empty_task():
    subagent.set_subagent_adapter(_FakeAdapter([("", [])]))
    assert "为空" in subagent.run_subagent("   ")


def test_rejects_ungrounded_file_claim():
    subagent.set_subagent_adapter(_FakeAdapter([("发现：入口在 foo.py:10", [])]))
    out = subagent.run_subagent("探索 foo")
    assert "Task incomplete" in out
    assert "not grounded in executed tool evidence" in out


# -- 安全：受限执行器 + 工具集 ------------------------------------------------


def test_restricted_executor_blocks_write():
    res = subagent._restricted_executor("write_file", {"filename": "x", "content": "y"})
    assert not res.success
    assert "无权" in res.error


def test_restricted_executor_allows_explore():
    res = subagent._restricted_executor("list_files", {})
    assert "无权" not in (res.error or "")  # 放行（成功与否取决于工作区）


def test_role_bound_executor_does_not_share_global_role():
    subagent._set_current_role("test-writer")

    res = subagent._executor_for_role("explore")("write_file", {"filename": "x", "content": "y"})

    assert not res.success
    assert "role=explore" in res.error


def test_unknown_role_is_rejected():
    subagent.set_subagent_adapter(_FakeAdapter([("x", [])]))

    out = subagent.run_subagent("scan", role="admin")

    assert "unknown subagent role" in out


def test_list_subagent_roles_exposes_permissions():
    roles = {item["role"]: item for item in subagent.list_subagent_roles()}

    assert roles["explore"]["category"] == "read"
    assert roles["reviewer"]["writable"] is False
    assert roles["test-writer"]["category"] == "workspace_write"
    assert "write_file" in roles["test-writer"]["tools"]
    assert roles["debugger"]["category"] == "workspace_cmd"


def test_explore_toolset_excludes_spawn_and_write():
    assert "spawn_subagent" not in subagent._EXPLORE_TOOLS  # 防递归
    assert "write_file" not in subagent._EXPLORE_TOOLS
    assert "edit_file" not in subagent._EXPLORE_TOOLS
    assert "create_file" not in subagent._EXPLORE_TOOLS
    assert "code_search" in subagent._EXPLORE_TOOLS


def test_adapter_set_get_clear():
    a = _FakeAdapter([("x", [])])
    subagent.set_subagent_adapter(a)
    assert subagent.get_subagent_adapter() is a
    subagent.clear_subagent_adapter()
    assert subagent.get_subagent_adapter() is None


def test_run_subagent_inherits_parent_cancellation(monkeypatch):
    subagent.set_subagent_adapter(_FakeAdapter([("unused", [])]))
    captured = {}

    def fake_run_tool_loop(*args, **kwargs):
        captured["should_stop"] = kwargs["should_stop"]
        captured["model_timeout_seconds"] = kwargs["model_timeout_seconds"]
        return SimpleNamespace(answer="stopped")

    monkeypatch.setattr("arforge.core.agentic.run_tool_loop", fake_run_tool_loop)
    with subagent.subagent_stop_scope(lambda: True):
        out = subagent.run_subagent("inspect", timeout_seconds=30)

    assert out == "stopped"
    assert captured["should_stop"]() is True
    assert captured["model_timeout_seconds"] == 30


def test_tool_loop_propagates_parent_cancellation_to_spawn(monkeypatch):
    import arforge.tools.subagent_tools  # noqa: F401
    from arforge.core.agentic import run_tool_loop

    observed = {}

    def fake_run(task, role="explore"):
        inherited = subagent.get_subagent_parent_should_stop()
        observed["callable"] = callable(inherited)
        observed["value"] = inherited() if callable(inherited) else None
        return "child complete"

    monkeypatch.setattr("arforge.core.subagent.run_subagent", fake_run)
    tc = SimpleNamespace(
        id="spawn-1",
        name="spawn_subagent",
        arguments='{"task":"inspect","role":"explore"}',
    )
    adapter = _FakeAdapter([("", [tc]), ("parent complete", [])])

    result = run_tool_loop(
        adapter,
        [{"role": "user", "content": "inspect"}],
        tools=REGISTRY.to_openai_tools(),
        max_steps=2,
        should_stop=lambda: False,
    )

    assert result.answer == "parent complete"
    assert observed == {"callable": True, "value": False}


# -- spawn_subagent 工具 ------------------------------------------------------


def test_spawn_subagent_tool_registered():
    import arforge.tools.subagent_tools  # noqa: F401  触发注册

    tool = REGISTRY.get("spawn_subagent")
    assert tool is not None
    assert tool.schema.category == "read"
    write_tool = REGISTRY.get("spawn_write_subagent")
    assert write_tool is not None
    assert write_tool.schema.category == "workspace_write"
    assert write_tool.schema.risk_level == "medium"


def test_spawn_subagent_tool_invokes_run(monkeypatch):
    import arforge.tools.subagent_tools  # noqa: F401

    captured = {}

    def fake_run(task, role="explore"):
        captured["task"] = task
        captured["role"] = role
        return "子代理结论"

    monkeypatch.setattr("arforge.core.subagent.run_subagent", fake_run)
    res = REGISTRY.execute_by_name("spawn_subagent", {"task": "查 X", "role": "explore"})
    assert res.success
    assert "子代理结论" in res.output
    assert captured["task"] == "查 X"


def test_spawn_subagent_rejects_write_capable_role(monkeypatch):
    import arforge.tools.subagent_tools  # noqa: F401

    called = False

    def fake_run(task, role="explore"):
        nonlocal called
        called = True
        return "should not run"

    monkeypatch.setattr("arforge.core.subagent.run_subagent", fake_run)
    res = REGISTRY.execute_by_name("spawn_subagent", {"task": "write tests", "role": "test-writer"})

    assert res.success
    assert "not read-only" in res.output
    assert called is False


def test_spawn_write_subagent_allows_test_writer(monkeypatch):
    import arforge.tools.subagent_tools  # noqa: F401

    captured = {}

    def fake_run(task, role="test-writer"):
        captured["task"] = task
        captured["role"] = role
        return "tests written"

    monkeypatch.setattr("arforge.core.subagent.run_subagent", fake_run)
    res = REGISTRY.execute_by_name("spawn_write_subagent", {"task": "write tests", "role": "test-writer"})

    assert res.success
    assert res.output == "tests written"
    assert captured == {"task": "write tests", "role": "test-writer"}


def test_subagent_end_to_end_with_tool_call():
    """子代理先调一个只读工具，再给结论（验证 executor 放行 + 闭环）。"""
    tc = SimpleNamespace(id="c1", name="list_files", arguments="{}")
    subagent.set_subagent_adapter(
        _FakeAdapter(
            [
                ("", [tc]),  # 第 1 步：调 list_files
                ("调查完成：共 N 个文件", []),  # 第 2 步：给结论
            ]
        )
    )
    out = subagent.run_subagent("列出文件并总结")
    assert "调查完成" in out
