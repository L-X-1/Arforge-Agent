"""PM-1/PM-2 权限分类与三模式矩阵 验收测试。

覆盖：classify_command（workspace_cmd/network/system/dangerous）、PermissionManager.decide
三模式矩阵、classify_tool（静态 category + run_cmd 动态 + 越界写判 dangerous）、未激活放行。
"""

import os
import threading

import pytest

from arforge.core.permission import (
    PermissionMode,
    PermissionManager,
    classify_command,
    classify_tool,
    get_permission_manager,
    permission_scope,
    reset_permission_manager,
)


@pytest.fixture(autouse=True)
def _reset():
    reset_permission_manager()
    yield
    reset_permission_manager()


def test_classify_command_dangerous():
    assert classify_command("shutdown -h now") == "dangerous"
    assert classify_command("format c: /q") == "dangerous"


def test_classify_command_network():
    assert classify_command("curl http://example.com") == "network"
    assert classify_command("git push origin main") == "network"
    assert classify_command("npm install left-pad") == "network"


def test_classify_command_system():
    assert classify_command("sudo systemctl restart nginx") == "system"
    assert classify_command("chmod +x run.sh") == "system"


def test_classify_command_workspace():
    assert classify_command("pytest -q") == "workspace_cmd"
    assert classify_command("python build.py") == "workspace_cmd"


def test_decide_matrix_plan_is_readonly():
    pm = PermissionManager()
    pm.set_mode("plan")
    assert pm.decide("read") == "allow"
    for cat in ("workspace_write", "workspace_cmd", "network", "system", "dangerous"):
        assert pm.decide(cat) == "deny"


def test_decide_matrix_request_approval():
    pm = PermissionManager()
    pm.set_mode("requestApproval")
    assert pm.get_mode() == PermissionMode.REQUEST_APPROVAL
    assert pm.decide("read") == "allow"
    for cat in ("workspace_write", "workspace_cmd", "network", "system", "dangerous"):
        assert pm.decide(cat) == "ask"


def test_decide_matrix_accept_edits():
    pm = PermissionManager()
    pm.set_mode("acceptEdits")
    assert pm.decide("read") == "allow"
    assert pm.decide("workspace_write") == "allow"
    assert pm.decide("workspace_cmd") == "allow"
    assert pm.decide("network") == "ask"
    assert pm.decide("system") == "ask"
    assert pm.decide("dangerous") == "deny"


def test_decide_matrix_auto():
    pm = PermissionManager()
    pm.set_mode("auto")
    for cat in ("read", "workspace_write", "workspace_cmd", "network", "system"):
        assert pm.decide(cat) == "allow"
    assert pm.decide("dangerous") == "ask"


def test_decide_matrix_auto_approve():
    pm = PermissionManager()
    pm.set_mode("autoApprove")
    assert pm.decide("read") == "allow"
    assert pm.decide("workspace_write") == "allow"
    assert pm.decide("workspace_cmd") == "allow"
    assert pm.decide("network") == "ask"
    assert pm.decide("system") == "ask"
    assert pm.decide("dangerous") == "ask"


def test_product_service_defaults_to_background_approval_for_workspace_work():
    from arforge.product.service import ProductService

    result = ProductService().permission_mode_get({})

    assert result == {"mode": "autoApprove"}
    manager = get_permission_manager()
    assert manager.decide("workspace_write") == "allow"
    assert manager.decide("workspace_cmd") == "allow"
    assert manager.decide("network") == "ask"
    assert manager.decide("dangerous") == "ask"


def test_decide_matrix_full_access():
    pm = PermissionManager()
    pm.set_mode("fullAccess")
    for cat in ("read", "workspace_write", "workspace_cmd", "network", "system", "dangerous"):
        assert pm.decide(cat) == "allow"


def test_decide_inactive_allows_all():
    pm = PermissionManager()
    assert not pm.is_active()
    assert pm.decide("dangerous") == "allow"
    assert pm.decide("network") == "allow"


def test_permission_scope_is_operation_local_and_restores_default():
    manager = get_permission_manager()
    manager.set_mode("requestApproval")
    barrier = threading.Barrier(2)
    observed: dict[str, PermissionMode | None] = {}

    def inspect_scope(label: str, mode: str) -> None:
        with permission_scope(mode):
            barrier.wait()
            observed[label] = manager.get_mode()

    first = threading.Thread(target=inspect_scope, args=("first", "fullAccess"))
    second = threading.Thread(target=inspect_scope, args=("second", "autoApprove"))
    first.start()
    second.start()
    first.join()
    second.join()

    assert observed == {
        "first": PermissionMode.FULL_ACCESS,
        "second": PermissionMode.AUTO_APPROVE,
    }
    assert manager.get_mode() == PermissionMode.REQUEST_APPROVAL


def test_unknown_category_treated_as_dangerous():
    pm = PermissionManager()
    pm.set_mode("acceptEdits")
    assert pm.decide("totally_unknown_category") == "deny"  # 走 dangerous 行 → acceptEdits=deny


def test_classify_tool_uses_registry_category():
    import arforge.tools.file_tools  # noqa: F401  注册带 category 的工具
    assert classify_tool("write_file", {"filename": "a.txt", "content": "x"}) == "workspace_write"
    assert classify_tool("read_file", {"filename": "a.txt"}) == "read"


def test_classify_tool_runcmd_is_dynamic():
    import arforge.tools.basic_tools  # noqa: F401
    assert classify_tool("run_cmd", {"command": "git push"}) == "network"
    assert classify_tool("run_cmd", {"command": "pytest"}) == "workspace_cmd"
    assert classify_tool("run_cmd", {"command": "shutdown now"}) == "dangerous"


def test_classify_tool_local_external_path_is_dangerous(tmp_path, monkeypatch):
    import arforge.tools.file_tools as ft

    monkeypatch.setattr(ft, "WORKSPACE", tmp_path)
    assert classify_tool("write_file", {"filename": "inside.txt", "content": "x"}) == "workspace_write"
    outside = str(tmp_path.parent / "outside.txt")
    assert classify_tool("write_file", {"filename": outside, "content": "x"}) == "dangerous"


def test_classify_tool_protected_path_is_dangerous(tmp_path, monkeypatch):
    import arforge.tools.file_tools as ft

    monkeypatch.setattr(ft, "WORKSPACE", tmp_path)
    outside = "C:/Windows/System32/x.txt" if os.name == "nt" else "/etc/x.txt"
    assert classify_tool("write_file", {"filename": outside, "content": "x"}) == "dangerous"
