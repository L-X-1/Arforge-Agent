"""v1-2.1 eval 回归门禁（eval_baseline）测试。"""

from __future__ import annotations

import pytest

from arforge.core.eval_baseline import (
    check_regression,
    load_baseline,
    report_to_baseline,
    save_baseline,
)
from arforge.eval import EvalCase, EvalReport


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    yield


def _report(pairs):
    """pairs: [(task_id, success), ...] → EvalReport。"""
    r = EvalReport()
    for tid, ok in pairs:
        r.cases.append(EvalCase(task_id=tid, success=ok))
    return r


def test_report_to_baseline_structure():
    b = report_to_baseline(_report([("a", True), ("b", False)]))
    assert b["total"] == 2
    assert b["passed"] == 1
    assert b["per_task"] == {"a": True, "b": False}


def test_save_load_roundtrip():
    save_baseline(_report([("a", True), ("b", True)]))
    b = load_baseline()
    assert b["success_rate"] == 1.0
    assert b["per_task"] == {"a": True, "b": True}


def test_load_missing_returns_none():
    assert load_baseline() is None


def test_no_baseline_passes_gate():
    ok, msg = check_regression(_report([("a", True)]), None)
    assert ok
    assert "无基线" in msg


def test_success_rate_drop_is_regression():
    baseline = report_to_baseline(_report([("a", True), ("b", True)]))  # 100%
    cur = _report([("a", True), ("b", False)])  # 50%
    ok, msg = check_regression(cur, baseline)
    assert not ok
    assert "回退" in msg


def test_task_pass_to_fail_is_regression():
    baseline = report_to_baseline(_report([("a", True), ("b", False)]))  # 50%
    cur = _report([("a", False), ("b", True)])  # 也 50% 但 a 退化
    ok, msg = check_regression(cur, baseline)
    assert not ok
    assert "a" in msg


def test_no_regression_passes():
    baseline = report_to_baseline(_report([("a", True), ("b", False)]))  # 50%
    cur = _report([("a", True), ("b", True)])  # 100% 提升
    ok, msg = check_regression(cur, baseline)
    assert ok
    assert "无回归" in msg
