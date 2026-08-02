"""G7 改后即验证（edit_verify）测试。"""

from __future__ import annotations

import pytest

from arforge.core import edit_verify
from arforge.core.edit_verify import verify_edit_hook, verify_path
from arforge.core.hooks import HookContext, HookEvent, get_hook_manager, reset_hook_manager
from arforge.tool_registry import ToolResult


# -- verify_path 各类型 -------------------------------------------------------


def test_verify_py_ok(tmp_path):
    f = tmp_path / "good.py"
    f.write_text("def f(x):\n    return x + 1\n", encoding="utf-8")
    assert verify_path(f) == (True, "")


def test_verify_py_syntax_error(tmp_path):
    f = tmp_path / "bad.py"
    f.write_text("def f(:\n    pass\n", encoding="utf-8")
    ok, msg = verify_path(f)
    assert not ok
    assert "语法" in msg


def test_verify_json_ok(tmp_path):
    f = tmp_path / "x.json"
    f.write_text('{"a": 1, "b": [2, 3]}', encoding="utf-8")
    assert verify_path(f) == (True, "")


def test_verify_json_error(tmp_path):
    f = tmp_path / "x.json"
    f.write_text('{"a": 1,,}', encoding="utf-8")
    ok, msg = verify_path(f)
    assert not ok
    assert "JSON" in msg


def test_verify_unknown_ext_skipped(tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("anything goes :( not code", encoding="utf-8")
    assert verify_path(f) == (True, "")


def test_verify_missing_file_skipped(tmp_path):
    assert verify_path(tmp_path / "nope.py") == (True, "")


def test_verify_yaml_error(tmp_path):
    pytest.importorskip("yaml")  # 未安装则跳过
    f = tmp_path / "x.yaml"
    f.write_text("a: [1, 2\nb: 3\n", encoding="utf-8")  # 未闭合 flow 序列
    ok, msg = verify_path(f)
    assert not ok


# -- verify_edit_hook 回灌 ----------------------------------------------------


def _ctx(tool_name, filename, success=True):
    return HookContext(
        HookEvent.POST_TOOL_USE,
        tool_name=tool_name,
        tool_args={"filename": filename},
        tool_result=ToolResult(tool_name, success, "ok" if success else ""),
    )


def test_hook_flags_bad_py(tmp_path, monkeypatch):
    bad = tmp_path / "bad.py"
    bad.write_text("def f(:\n  pass\n", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: bad)
    ctx = _ctx("write_file", "bad.py")
    verify_edit_hook(ctx)
    assert ctx.feedback
    assert "bad.py" in ctx.feedback[0]["content"]
    assert ctx.feedback[0]["role"] == "user"


def test_hook_silent_on_good_py(tmp_path, monkeypatch):
    good = tmp_path / "good.py"
    good.write_text("x = 1\n", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: good)
    ctx = _ctx("write_file", "good.py")
    verify_edit_hook(ctx)
    assert ctx.feedback == []


def test_hook_ignores_non_write_tool(tmp_path, monkeypatch):
    bad = tmp_path / "bad.py"
    bad.write_text("def f(:\n", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: bad)
    ctx = _ctx("read_file", "bad.py")
    verify_edit_hook(ctx)
    assert ctx.feedback == []


def test_hook_ignores_failed_tool(tmp_path, monkeypatch):
    bad = tmp_path / "bad.py"
    bad.write_text("def f(:\n", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: bad)
    ctx = _ctx("write_file", "bad.py", success=False)
    verify_edit_hook(ctx)
    assert ctx.feedback == []


def test_hook_edit_file_also_verified(tmp_path, monkeypatch):
    bad = tmp_path / "mod.py"
    bad.write_text("def f(:\n", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: bad)
    ctx = _ctx("edit_file", "mod.py")
    verify_edit_hook(ctx)
    assert ctx.feedback  # edit_file 同样触发校验


# -- install 开关 -------------------------------------------------------------


def _post_tool_handler_names():
    return [e.name for e in get_hook_manager()._handlers.get(HookEvent.POST_TOOL_USE, [])]


def test_install_registers_hook(monkeypatch):
    reset_hook_manager()
    monkeypatch.setenv("ARFORGE_EDIT_VERIFY", "1")
    edit_verify.install_edit_verify_hook()
    assert "edit_verify" in _post_tool_handler_names()


def test_install_disabled_by_env(monkeypatch):
    reset_hook_manager()
    monkeypatch.setenv("ARFORGE_EDIT_VERIFY", "0")
    edit_verify.install_edit_verify_hook()
    assert "edit_verify" not in _post_tool_handler_names()


def test_install_then_fire_end_to_end(tmp_path, monkeypatch):
    """install → fire POST_TOOL_USE → feedback 被注入 ctx。"""
    reset_hook_manager()
    monkeypatch.setenv("ARFORGE_EDIT_VERIFY", "1")
    edit_verify.install_edit_verify_hook()
    bad = tmp_path / "e2e.py"
    bad.write_text("import (\n", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: bad)
    ctx = _ctx("write_file", "e2e.py")
    get_hook_manager().fire(ctx)
    assert any("e2e.py" in fb["content"] for fb in ctx.feedback)
