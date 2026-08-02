"""v1-1.4 Plan Mode（plan_mode）测试。"""

from __future__ import annotations

from arforge.core import plan_mode
from arforge.core.plan_mode import PLAN_GUIDE, approval_decision, build_structured_plan, read_approval, read_approval_action


def test_plan_guide_is_readonly_instruction():
    assert "只读" in PLAN_GUIDE
    assert "方案" in PLAN_GUIDE
    assert "不要写或改文件" in PLAN_GUIDE


def test_read_approval_yes():
    assert read_approval(lambda _p: "y") is True
    assert read_approval(lambda _p: "yes") is True
    assert read_approval(lambda _p: "是") is True
    assert read_approval(lambda _p: " Y ") is True


def test_read_approval_no():
    assert read_approval(lambda _p: "n") is False
    assert read_approval(lambda _p: "") is False
    assert read_approval(lambda _p: "whatever") is False


def test_read_approval_action_supports_edit():
    assert read_approval_action(lambda _p: "y") == "approve"
    assert read_approval_action(lambda _p: "edit") == "edit"
    assert read_approval_action(lambda _p: "n") == "reject"


def test_read_approval_eof():
    def _raise(_p):
        raise EOFError

    assert read_approval(_raise) is False


def test_approval_auto_approved(monkeypatch):
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    assert approval_decision(lambda _p: "n") is True  # auto 覆盖询问


def test_approval_non_tty_false(monkeypatch):
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    monkeypatch.setattr(plan_mode, "_stdin_is_tty", lambda: False)
    assert approval_decision(lambda _p: "y") is False  # 非交互 → 安全默认不执行


def test_approval_tty_yes_no(monkeypatch):
    monkeypatch.delenv("ARFORGE_AUTO_APPROVE", raising=False)
    monkeypatch.setattr(plan_mode, "_stdin_is_tty", lambda: True)
    assert approval_decision(lambda _p: "y") is True
    assert approval_decision(lambda _p: "n") is False


def test_build_structured_plan_contract():
    plan = build_structured_plan(
        "Add plan mode card",
        """# Plan
1. Inspect desktop/src/App.tsx and arforge/bridge.py.
2. Add read-only Bridge contract.
3. Run pytest and npm test.
Risk: UI can drift from backend fields.
Rollback: revert the touched files.
""",
        explored_files=["docs/FEATURE_CONTRACT.md"],
        estimated_steps=3,
    )

    assert plan["schema_version"] == 1
    assert plan["mode"] == "plan"
    assert plan["approval_required"] is True
    assert plan["execution_mode_after_approval"] == "acceptEdits"
    assert plan["task"] == "Add plan mode card"
    assert "desktop/src/App.tsx" in plan["affected_files"]
    assert "arforge/bridge.py" in plan["affected_files"]
    assert "docs/FEATURE_CONTRACT.md" in plan["affected_files"]
    assert plan["steps"][0] == {"index": 1, "content": "Inspect desktop/src/App.tsx and arforge/bridge.py.", "status": "pending"}
    assert plan["estimated_steps"] == 3
    assert plan["risks"]
    assert plan["rollback"]
