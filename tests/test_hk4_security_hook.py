"""HK-4 安全沙箱迁为 PRE_TOOL_USE 中间件 验收测试。

覆盖：无角色放行、越界写拦截、工作区内放行、命令能力白名单、role_scope 还原、install 注册。
（端到端沙箱拦截另由 test_multiagent_security_integration 经 run_agentic_task 验证。）
"""

import pytest

from arforge.core.hooks import HookContext, HookEvent, get_hook_manager, reset_hook_manager
from arforge.multiagent import security
from arforge.multiagent.protocol import AgentRole


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))  # 隔离审计日志
    reset_hook_manager()
    yield
    reset_hook_manager()


def _role(name="W", caps=None, tools=None):
    return AgentRole(name=name, description="", capabilities=caps or [], tools=tools or [], max_tokens=4096, timeout=60, system_prompt="")


def _ctx(tool, args):
    return HookContext(HookEvent.PRE_TOOL_USE, tool_name=tool, tool_args=args)


def test_sandbox_hook_noop_without_active_role():
    assert security.sandbox_hook(_ctx("write_file", {"filename": "C:/Windows/x.txt", "content": "x"})) is None


def test_sandbox_hook_blocks_out_of_sandbox_write():
    with security.role_scope(_role()):
        dec = security.sandbox_hook(_ctx("write_file", {"filename": "C:/Windows/System32/evil.txt", "content": "x"}))
    assert dec is not None and dec.action == "block"


def test_sandbox_hook_allows_workspace_write(tmp_path, monkeypatch):
    monkeypatch.setattr(security, "_DEFAULT_WORKSPACE", str(tmp_path))
    with security.role_scope(_role()):
        dec = security.sandbox_hook(_ctx("write_file", {"filename": str(tmp_path / "ok.txt"), "content": "x"}))
    assert dec is None  # 工作区内 → 放行


def test_sandbox_hook_blocks_run_cmd_without_capability():
    with security.role_scope(_role(caps=[])):
        dec = security.sandbox_hook(_ctx("run_cmd", {"command": "ls"}))
    assert dec is not None and dec.action == "block"


def test_sandbox_hook_allows_run_cmd_with_capability():
    with security.role_scope(_role(caps=["command_execution"])):
        assert security.sandbox_hook(_ctx("run_cmd", {"command": "ls"})) is None


def test_role_scope_sets_and_resets():
    assert security._active_role.get() is None
    with security.role_scope(_role()):
        assert security._active_role.get() is not None
    assert security._active_role.get() is None


def test_install_security_hooks_registers_on_pre_tool_use():
    security.install_security_hooks()
    assert get_hook_manager().handler_count(HookEvent.PRE_TOOL_USE) == 1
