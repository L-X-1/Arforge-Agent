"""PM-3 权限裁决器接入 run_tool_loop 验收测试。

覆盖：PLAN 拒写、ACCEPT_EDITS 放行工作区写、ACCEPT_EDITS 越界写判 dangerous 被拒、
ACCEPT_EDITS 网络 ask 在无 TTY 下被拒、AUTO 放行网络、未激活=无操作；
以及真实 REGISTRY 路径下 confirmed_operation 抑制二次确认（无 AUTO_APPROVE/TTY 也能写）。
"""

import json
import os

import pytest

from arforge.core.agentic import run_tool_loop
from arforge.core.hooks import reset_hook_manager
from arforge.core.permission import install_permission_hooks, reset_permission_manager
from arforge.tool_registry import ToolResult

import arforge.tools.basic_tools  # noqa: F401  注册 run_cmd
import arforge.tools.file_tools  # noqa: F401  注册 write_file/edit_file（带 category）


class _TC:
    def __init__(self, id, name, arguments):
        self.id = id
        self.name = name
        self.arguments = arguments


class _Resp:
    def __init__(self, content="", tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage = {}
        self.finish_reason = "stop"


class CallThenDone:
    """step1 调用指定工具，step2 收尾。"""

    model_name = "fake"

    def __init__(self, name="write_file", arguments='{"filename": "a.txt", "content": "x"}'):
        self.calls = 0
        self.name = name
        self.arguments = arguments

    def generate_with_tools(self, messages, tools=None, tool_choice="auto"):
        self.calls += 1
        if self.calls == 1:
            return _Resp(tool_calls=[_TC("c1", self.name, self.arguments)])
        return _Resp(content="done")


@pytest.fixture(autouse=True)
def _reset():
    reset_hook_manager()
    reset_permission_manager()
    yield
    reset_hook_manager()
    reset_permission_manager()


def _run_with_executor(adapter):
    calls = []

    def executor(name, args):
        calls.append((name, dict(args)))
        return ToolResult(name, True, "ok")

    result = run_tool_loop(adapter, [{"role": "user", "content": "hi"}], tools=[], max_steps=5, executor=executor)
    return calls, result


def test_plan_mode_blocks_write():
    install_permission_hooks("plan")
    calls, result = _run_with_executor(CallThenDone())
    assert calls == []  # 写被拒
    assert any(c["tool"] == "write_file" and not c["success"] for c in result.tool_calls)


def test_accept_edits_allows_workspace_write():
    install_permission_hooks("acceptEdits")
    calls, _ = _run_with_executor(CallThenDone())
    assert calls == [("write_file", {"filename": "a.txt", "content": "x"})]


def test_accept_edits_blocks_dangerous_escape(tmp_path, monkeypatch):
    import arforge.tools.file_tools as ft

    monkeypatch.setattr(ft, "WORKSPACE", tmp_path)
    install_permission_hooks("acceptEdits")
    outside = "C:/Windows/x.txt" if os.name == "nt" else "/etc/x.txt"
    calls, _ = _run_with_executor(CallThenDone(arguments=json.dumps({"filename": outside, "content": "x"})))
    assert calls == []  # 越界写 = dangerous，acceptEdits 也拒


def test_accept_edits_asks_network_denied_without_tty(monkeypatch):
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    install_permission_hooks("acceptEdits")
    calls, _ = _run_with_executor(CallThenDone(name="run_cmd", arguments='{"command": "curl http://x"}'))
    assert calls == []  # network → ask → 无 TTY/无 AUTO_APPROVE → 拒


def test_auto_mode_allows_network():
    install_permission_hooks("auto")
    calls, _ = _run_with_executor(CallThenDone(name="run_cmd", arguments='{"command": "git push"}'))
    assert calls == [("run_cmd", {"command": "git push"})]


def test_user_permission_denial_stops_before_alternative_retry(monkeypatch):
    from arforge.security.file_ops import confirmation_handler

    class RetryAlternative:
        model_name = "fake"

        def __init__(self):
            self.calls = 0

        def generate_with_tools(self, _messages, tools=None, **_kwargs):
            self.calls += 1
            if tools is None:
                return _Resp(content="Permission was denied; nothing was executed.")
            command = "python -c print(1)" if self.calls == 1 else "python3 -c print(1)"
            return _Resp(
                tool_calls=[
                    _TC(
                        f"c{self.calls}",
                        "run_cmd",
                        json.dumps({"command": command}),
                    )
                ]
            )

    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    install_permission_hooks("requestApproval")
    adapter = RetryAlternative()
    with confirmation_handler(lambda _risk, _description: False):
        calls, result = _run_with_executor(adapter)

    assert calls == []
    assert adapter.calls == 2
    assert result.answer == "Permission was denied; nothing was executed."
    assert result.self_correct["stop_reason"] == "permission_denied"
    assert result.incomplete_report["stop_reason"] == "permission_denied"
    assert any(item["event"] == "permission_denied_terminal" for item in result.trace)


def test_full_access_allows_desktop_file_write(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    fake_home = tmp_path / "home"
    desktop = fake_home / "Desktop"
    desktop.mkdir(parents=True)
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("HOME", str(fake_home))
    install_permission_hooks("fullAccess")

    adapter = CallThenDone(arguments=json.dumps({"filename": str(desktop / "111.txt"), "content": "Hello, world"}))
    run_tool_loop(adapter, [{"role": "user", "content": "create desktop file"}], tools=[], max_steps=5)

    assert (desktop / "111.txt").read_text(encoding="utf-8") == "Hello, world"


@pytest.mark.skipif(os.name != "nt", reason="percent-style USERPROFILE expansion is Windows-specific")
def test_full_access_expands_userprofile_desktop_file_write(tmp_path, monkeypatch):
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    fake_home = tmp_path / "home"
    desktop = fake_home / "Desktop"
    desktop.mkdir(parents=True)
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("HOME", str(fake_home))
    install_permission_hooks("fullAccess")

    target = r"%USERPROFILE%\Desktop\222.txt"
    adapter = CallThenDone(arguments=json.dumps({"filename": target, "content": "expanded"}))
    run_tool_loop(adapter, [{"role": "user", "content": "create desktop file"}], tools=[], max_steps=5)

    assert (desktop / "222.txt").read_text(encoding="utf-8") == "expanded"


def test_auto_approve_keeps_external_file_write_approval_gated(tmp_path, monkeypatch):
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    fake_home = tmp_path / "home"
    desktop = fake_home / "Desktop"
    desktop.mkdir(parents=True)
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("HOME", str(fake_home))
    install_permission_hooks("autoApprove")

    calls, _ = _run_with_executor(
        CallThenDone(arguments=json.dumps({"filename": str(desktop / "blocked.txt"), "content": "x"}))
    )

    assert calls == []
    assert not (desktop / "blocked.txt").exists()


def test_inactive_permission_is_noop():
    # 未 install → 无 decider → 写正常执行
    calls, _ = _run_with_executor(CallThenDone())
    assert calls == [("write_file", {"filename": "a.txt", "content": "x"})]


def test_confirmed_operation_suppresses_registry_prompt(tmp_path, monkeypatch):
    """真实 REGISTRY 路径：ACCEPT_EDITS 下中央 decider 放行后自动确认，
    即便无 AUTO_APPROVE / 无 TTY 也能写入（confirmed_operation 抑制 REGISTRY 二次确认）。"""
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    import arforge.tools.file_tools as ft

    monkeypatch.setattr(ft, "WORKSPACE", tmp_path)
    install_permission_hooks("acceptEdits")

    adapter = CallThenDone(arguments=json.dumps({"filename": "proof.txt", "content": "hello"}))
    run_tool_loop(adapter, [{"role": "user", "content": "hi"}], tools=[], max_steps=5)  # 无 executor → 真实 REGISTRY

    written = tmp_path / "proof.txt"
    assert written.exists()
    assert written.read_text(encoding="utf-8") == "hello"
