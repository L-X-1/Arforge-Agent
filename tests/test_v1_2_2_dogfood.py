"""v1-2.2 dogfood 数据闭环测试。"""

from __future__ import annotations

import json

import pytest

from arforge.core.dogfood import (
    RunOutcome,
    formal_dogfood_report,
    load_outcomes,
    longitudinal_dogfood_report,
    record_outcome,
    render_stats,
    stats,
)


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))  # 隔离 dogfood.jsonl
    yield


def test_record_and_load_roundtrip():
    assert record_outcome(RunOutcome(task="t1", success=True, steps=3, tokens=100, cost_cny=0.01))
    rows = load_outcomes()
    assert len(rows) == 1
    assert rows[0]["task"] == "t1"
    assert rows[0]["success"] is True
    assert rows[0]["ts"]  # 自动填时间戳


def test_append_multiple():
    record_outcome(RunOutcome(task="a", success=True))
    record_outcome(RunOutcome(task="b", success=False))
    assert len(load_outcomes()) == 2


def test_stats_success_rate_and_avg():
    record_outcome(RunOutcome(task="a", success=True, steps=2))
    record_outcome(RunOutcome(task="b", success=True, steps=4))
    record_outcome(RunOutcome(task="c", success=False, steps=6))
    s = stats()
    assert s["total"] == 3
    assert s["passed"] == 2
    assert s["failed"] == 1
    assert s["success_rate"] == round(2 / 3, 4)
    assert s["avg_steps"] == 4.0


def test_stats_empty():
    assert stats() == {
        "total": 0,
        "passed": 0,
        "failed": 0,
        "success_rate": 0.0,
        "avg_steps": 0.0,
        "total_tokens": 0,
        "total_cost_cny": 0.0,
    }


def test_load_skips_bad_lines():
    from arforge.core.dogfood import _dogfood_file

    f = _dogfood_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(
        '{"task":"ok","success":true}\nNOT JSON\n\n{"task":"ok2","success":false}\n',
        encoding="utf-8",
    )
    assert len(load_outcomes()) == 2


def test_render_empty():
    assert "暂无" in render_stats()


def test_render_nonempty():
    record_outcome(RunOutcome(task="a", success=True, steps=2, tokens=50, cost_cny=0.005))
    text = render_stats()
    assert "累计 1 次" in text
    assert "成功 1" in text


def test_record_tolerates_io_error(monkeypatch):
    import arforge.core.dogfood as d

    def boom():
        raise OSError("disk full")

    monkeypatch.setattr(d, "_dogfood_file", boom)
    assert record_outcome(RunOutcome(task="x", success=True)) is False  # 不抛，返回 False


def _formal_outcome(task_id: str, *, success: bool = True) -> RunOutcome:
    return RunOutcome(
        task=f"formal task {task_id}",
        success=success,
        steps=8,
        tool_calls=5,
        llm_calls=8,
        tokens=100_000,
        run_id="run-release-1",
        task_id=task_id,
        suite_id="release-1",
        task_category="python",
        provider="deepseek",
        model="deepseek-chat",
        workspace=f"/isolated/{task_id}",
        duration_seconds=90,
        formal=True,
        real_model=True,
        isolated_workspace=True,
        verification_passed=True,
        verification={"command": "pytest", "exit_code": 0},
    )


def test_formal_dogfood_gate_passes_only_verified_unique_real_tasks():
    assert record_outcome(_formal_outcome("task-a"))
    assert record_outcome(_formal_outcome("task-b"))

    report = formal_dogfood_report(
        minimum_tasks=2,
        minimum_duration_seconds=60,
        required_categories=("python",),
    )

    assert report["status"] == "pass"
    assert report["unique_qualifying_tasks"] == 2
    assert report["success_rate"] == 1.0


def test_formal_dogfood_gate_rejects_legacy_short_and_duplicate_rows():
    record_outcome(RunOutcome(task="legacy", success=True))
    short = _formal_outcome("short")
    short.duration_seconds = 2
    record_outcome(short)
    record_outcome(_formal_outcome("duplicate"))
    record_outcome(_formal_outcome("duplicate"))

    report = formal_dogfood_report(
        minimum_tasks=2,
        required_categories=("python", "rust"),
    )

    assert report["status"] == "insufficient_evidence"
    assert report["unique_qualifying_tasks"] == 0
    assert report["duplicate_task_ids"] == ["duplicate"]
    assert report["missing_categories"] == ["python", "rust"]


def _longitudinal_outcome(
    task_id: str,
    *,
    suite_id: str,
    category: str,
    success: bool = True,
) -> RunOutcome:
    outcome = _formal_outcome(task_id, success=success)
    outcome.run_id = f"run-{suite_id}"
    outcome.suite_id = suite_id
    outcome.task_category = category
    outcome.verification_passed = success
    outcome.verification = {
        "command": "pytest",
        "exit_code": 0 if success else 1,
    }
    return outcome


def test_longitudinal_gate_tracks_first_latest_and_does_not_count_retries_twice():
    record_outcome(
        _longitudinal_outcome(
            "task-a",
            suite_id="suite-a",
            category="python",
            success=False,
        )
    )
    record_outcome(
        _longitudinal_outcome(
            "task-b",
            suite_id="suite-b",
            category="rust",
        )
    )
    record_outcome(
        _longitudinal_outcome(
            "task-a",
            suite_id="suite-a",
            category="python",
        )
    )

    report = longitudinal_dogfood_report(
        minimum_unique_tasks=2,
        minimum_suites=2,
        minimum_categories=2,
        minimum_first_attempt_success_rate=0.5,
        minimum_latest_success_rate=1.0,
    )

    assert report["status"] == "pass"
    assert report["qualifying_attempts"] == 3
    assert report["unique_tasks"] == 2
    assert report["first_attempt_success_rate"] == 0.5
    assert report["latest_success_rate"] == 1.0
    assert report["recovered_tasks"] == 1
    assert report["regressed_tasks"] == 0
    assert report["repeated_attempts"] == 1


def test_longitudinal_gate_fails_closed_on_regression_and_tampered_record():
    record_outcome(
        _longitudinal_outcome(
            "stable",
            suite_id="suite-a",
            category="python",
        )
    )
    record_outcome(
        _longitudinal_outcome(
            "regressed",
            suite_id="suite-b",
            category="rust",
        )
    )
    record_outcome(
        _longitudinal_outcome(
            "regressed",
            suite_id="suite-b",
            category="rust",
            success=False,
        )
    )
    record_outcome(
        _longitudinal_outcome(
            "tampered",
            suite_id="suite-c",
            category="go",
        )
    )

    from arforge.core.dogfood import _dogfood_file

    lines = _dogfood_file().read_text(encoding="utf-8").splitlines()
    tampered = json.loads(lines[-1])
    tampered["success"] = False
    lines[-1] = json.dumps(tampered)
    _dogfood_file().write_text("\n".join(lines) + "\n", encoding="utf-8")

    report = longitudinal_dogfood_report(
        minimum_unique_tasks=2,
        minimum_suites=2,
        minimum_categories=2,
        minimum_first_attempt_success_rate=0.5,
        minimum_latest_success_rate=0.5,
    )

    assert report["status"] == "fail"
    assert report["unique_tasks"] == 2
    assert report["regressed_tasks"] == 1
    assert "no_regressions" in report["failed_checks"]
