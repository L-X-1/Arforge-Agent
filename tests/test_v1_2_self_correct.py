from __future__ import annotations

from arforge.core.self_correct import SelfCorrectState, install_self_correct_hook


class TestSelfCorrectState:
    def test_first_failure_silent(self):
        s = SelfCorrectState()
        assert s.on_tool("t", False, "err") is None

    def test_reset_after_success(self):
        s = SelfCorrectState()
        s.on_tool("t", False, "e")  # fail 1: silent
        s.on_tool("t", True, "")    # success resets counter
        # After reset, first failure is silent again
        assert s.on_tool("t", False, "e") is None


def test_second_failure_reflects():
    s = SelfCorrectState()
    s.on_tool("run_cmd", False, "err")
    msg = s.on_tool("run_cmd", False, "err")
    assert msg and "root cause" in msg


def test_third_failure_escalates():
    s = SelfCorrectState()
    s.on_tool("run_cmd", False, "e")
    s.on_tool("run_cmd", False, "e")
    msg = s.on_tool("run_cmd", False, "e")
    assert msg
    assert "Change strategy" in msg or "not working" in msg


def test_no_duplicate_after_escalate():
    s = SelfCorrectState()
    s.on_tool("t", False, "e")  # 1 silent
    assert s.on_tool("t", False, "e")  # 2 reflect
    assert s.on_tool("t", False, "e")  # 3 escalate
    assert s.on_tool("t", False, "e") is None  # 4 no more


def test_different_tools_independent():
    s = SelfCorrectState()
    s.on_tool("a", False, "e")  # a: 1st fail (silent)
    s.on_tool("a", False, "e")  # a: 2nd fail (reflect)
    s.on_tool("b", False, "e")  # b: 1st fail (silent, independent)
    assert s.on_tool("b", False, "e") is not None  # b: 2nd fail -> reflect


def test_install_hook_returns_none():
    """install_self_correct_hook returns None (no active hooks by default)."""
    result = install_self_correct_hook()
    assert result is None
