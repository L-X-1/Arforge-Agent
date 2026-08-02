import pytest

import arforge.tools.permission_tools as pt
from arforge.core.permission import PermissionMode, get_permission_manager, reset_permission_manager


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    reset_permission_manager()
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    yield
    reset_permission_manager()


def test_enter_plan_mode_switches_to_request_approval():
    pm = get_permission_manager()
    pm.set_mode("fullAccess")

    out = pt.enter_plan_mode()

    assert pm.get_mode() == PermissionMode.REQUEST_APPROVAL
    assert "requestApproval" in out


def test_set_mode_deescalation_is_free():
    pm = get_permission_manager()
    pm.set_mode("fullAccess")

    out = pt.set_permission_mode("requestApproval")

    assert pm.get_mode() == PermissionMode.REQUEST_APPROVAL
    assert "set to requestApproval" in out


def test_set_mode_escalation_denied_without_approval():
    pm = get_permission_manager()
    pm.set_mode("requestApproval")

    out = pt.set_permission_mode("fullAccess")

    assert pm.get_mode() == PermissionMode.REQUEST_APPROVAL
    assert "denied" in out


def test_set_mode_escalation_allowed_with_auto_approve(monkeypatch):
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    pm = get_permission_manager()
    pm.set_mode("requestApproval")

    out = pt.set_permission_mode("fullAccess")

    assert pm.get_mode() == PermissionMode.FULL_ACCESS
    assert "set to fullAccess" in out


def test_set_mode_invalid():
    pm = get_permission_manager()
    pm.set_mode("requestApproval")

    out = pt.set_permission_mode("yolo")

    assert "invalid" in out
    assert pm.get_mode() == PermissionMode.REQUEST_APPROVAL


def test_exit_plan_mode_denied_without_approval():
    pm = get_permission_manager()
    pm.set_mode("requestApproval")

    out = pt.exit_plan_mode("step 1; step 2")

    assert pm.get_mode() == PermissionMode.REQUEST_APPROVAL
    assert "not approved" in out


def test_exit_plan_mode_approved(monkeypatch):
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    pm = get_permission_manager()
    pm.set_mode("requestApproval")

    out = pt.exit_plan_mode("do the thing")

    assert pm.get_mode() == PermissionMode.AUTO_APPROVE
    assert "autoApprove" in out
