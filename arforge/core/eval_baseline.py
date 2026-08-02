"""Eval regression baseline storage and comparison."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from arforge.paths import data_path


def _baseline_path() -> Path:
    return data_path("eval_baseline.json")


def report_to_baseline(report: Any) -> dict[str, Any]:
    """Convert an eval report into the persisted baseline contract."""
    data = _report_data(report)
    cases = list(data.get("cases") or [])
    per_task = {
        str(_case_value(case, "task_id")): bool(_case_value(case, "success"))
        for case in cases
        if _case_value(case, "task_id")
    }
    raw_total = int(data.get("total") or 0)
    total = raw_total if raw_total > 0 else len(cases)
    raw_passed = int(data.get("passed") or 0)
    passed = raw_passed if raw_total > 0 else sum(1 for ok in per_task.values() if ok)
    success_rate = (
        float(data.get("success_rate"))
        if raw_total > 0 and data.get("success_rate") is not None
        else (passed / total if total else 0.0)
    )
    return {
        "schema_version": 1,
        "suite": data.get("suite", "core"),
        "success_rate": round(success_rate, 3),
        "passed": passed,
        "total": total,
        "total_tokens": int(data.get("total_tokens") or 0),
        "per_task": per_task,
        "saved_at": data.get("saved_at", ""),
    }


def load_baseline() -> dict[str, Any] | None:
    """Load the most recent eval baseline, if any."""
    try:
        return json.loads(_baseline_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def save_baseline(report: Any) -> None:
    """Save current eval results as the new baseline."""
    baseline = report_to_baseline(report)
    target = _baseline_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(baseline, ensure_ascii=False, indent=2), encoding="utf-8")


def check_regression(report: Any, baseline: dict[str, Any] | None) -> tuple[bool, str]:
    """Compare current results against a baseline.

    Fails if the aggregate success rate drops by more than 5 percentage points
    or if any previously passing task now fails.
    """
    if baseline is None:
        return True, "无基线: No baseline exists yet. Run with --save-baseline to establish one."

    current = report_to_baseline(report)
    current_rate = float(current.get("success_rate") or 0.0)
    baseline_rate = float(baseline.get("success_rate") or 0.0)
    if current_rate < baseline_rate - 0.05:
        return False, f"回退: success rate dropped from {baseline_rate:.1%} to {current_rate:.1%}"

    baseline_tasks = baseline.get("per_task") if isinstance(baseline.get("per_task"), dict) else {}
    current_tasks = current.get("per_task") if isinstance(current.get("per_task"), dict) else {}
    regressions = sorted(
        task_id
        for task_id, was_passing in baseline_tasks.items()
        if was_passing is True and current_tasks.get(task_id) is False
    )
    if regressions:
        return False, "回退: previously passing task(s) failed: " + ", ".join(regressions)
    return True, f"无回归: {current_rate:.1%} vs baseline {baseline_rate:.1%}"


def _report_data(report: Any) -> dict[str, Any]:
    if isinstance(report, dict):
        return dict(report)
    if hasattr(report, "__dict__"):
        return dict(report.__dict__)
    return {}


def _case_value(case: Any, key: str) -> Any:
    if isinstance(case, dict):
        return case.get(key)
    return getattr(case, key, None)
