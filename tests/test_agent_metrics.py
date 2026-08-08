"""agent_metrics 聚合层测试：7 项指标、源选择、缺失容错、历史读写。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from arforge.core.agent_metrics import (
    agent_metrics_history,
    agent_metrics_report,
    clear_agent_metrics_history,
)

_METRIC_KEYS = (
    "success_rate",
    "avg_tool_calls",
    "invalid_action_rate",
    "first_attempt_success_rate",
    "recovery_success_rate",
    "verification_coverage",
    "verification_pass_rate",
    "patch_regression_rate",
)


def _arforge_dir(tmp_path: Path) -> Path:
    return tmp_path / ".arforge"


def _with_hash(row: dict) -> dict:
    payload = json.dumps(
        row, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    row = dict(row)
    row["record_hash"] = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return row


def _base_row(**overrides: object) -> dict:
    row = {
        "task": "task",
        "success": True,
        "steps": 10,
        "tool_calls": 10,
        "tokens": 60_000,
        "cost_cny": 1.0,
        "modified_files": 0,
        "ts": "2026-01-01 10:00:00",
        "schema_version": 2,
        "run_id": "run-1",
        "task_id": "task-1",
        "suite_id": "suite-1",
        "task_category": "code",
        "formal": True,
        "real_model": True,
        "isolated_workspace": True,
        "verification_passed": True,
        "verification": {"ok": True},
        "duration_seconds": 30.0,
        "max_steps": 20,
        "stop_reason": "",
        "reasoning_effort": "high",
    }
    row.update(overrides)
    return _with_hash(row)


def _write_dogfood(tmp_path: Path, rows: list[dict]) -> None:
    f = _arforge_dir(tmp_path) / "dogfood.jsonl"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )


def _write_json(tmp_path: Path, name: str, data: dict) -> None:
    f = _arforge_dir(tmp_path) / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _write_jsonl(tmp_path: Path, name: str, rows: list[dict]) -> None:
    f = _arforge_dir(tmp_path) / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )


def _full_dataset_rows() -> list[dict]:
    return [
        _base_row(
            task="t1", task_id="t1", suite_id="s1", success=True,
            tool_calls=10, failed_tool_calls=1, modified_files=2,
            verification_passed=True, verification={"ok": True},
        ),
        _base_row(
            task="t2", task_id="t2", suite_id="s1", success=False,
            tool_calls=20, failed_tool_calls=2, modified_files=0,
            verification_passed=False, verification={"ok": True},
        ),
        _base_row(
            task="t3", task_id="t3", suite_id="s2", success=True,
            tool_calls=5, failed_tool_calls=0, modified_files=3,
            verification_passed=True, verification={"ok": True},
        ),
        _base_row(
            task="t4", task_id="t4", suite_id="s2", success=True,
            tool_calls=15, modified_files=1,
            verification_passed=True, verification={"ok": True},
        ),
        _base_row(
            task="t5", task_id="t5", suite_id="s3", success=False,
            tool_calls=10, failed_tool_calls=3, modified_files=2,
            verification_passed=False, verification={"ok": True},
        ),
        _base_row(
            task="t6", task_id="t6", suite_id="s3", success=True,
            tool_calls=10, failed_tool_calls=0, modified_files=3,
            verification=None, verification_passed=False,
        ),
        _base_row(
            task="t7", task_id="t7", suite_id="s4", success=False,
            tool_calls=12, modified_files=0,
            verification_passed=False, verification={"ok": True},
        ),
        _base_row(
            task="t7", task_id="t7", suite_id="s4", success=True,
            tool_calls=12, modified_files=0,
            verification_passed=True, verification={"ok": True},
        ),
    ]


def _write_full_dataset(tmp_path: Path) -> None:
    _write_dogfood(tmp_path, _full_dataset_rows())
    _write_json(
        tmp_path,
        "self_correct_learning.json",
        {
            "fp1": {"task": "x"},
            "fp2": {"task": "y"},
            "_hint_performance": {
                "type_a": {"success": 3, "failure": 1},
                "type_b": {"success": 1, "failure": 3},
            },
        },
    )
    _write_jsonl(
        tmp_path,
        "recovery_outcomes.jsonl",
        [
            {
                "ts": "2026-01-01T00:00:00",
                "session_hash": "a",
                "recovery_state": "context",
                "verified": True,
                "duration_ms": 100,
                "note": "",
            },
            {
                "ts": "2026-01-01T00:00:01",
                "session_hash": "b",
                "recovery_state": "context",
                "verified": False,
                "duration_ms": 200,
                "note": "",
            },
        ],
    )
    _write_jsonl(
        tmp_path,
        "regression_runs.jsonl",
        [
            {
                "ts": "2026-01-01T00:00:00",
                "files": ["a.py"],
                "ran": 1,
                "passed": 0,
                "failed": 1,
                "returncode": 1,
                "summary": "fail",
            },
            {
                "ts": "2026-01-01T00:00:01",
                "files": ["b.py"],
                "ran": 1,
                "passed": 1,
                "failed": 0,
                "returncode": 0,
                "summary": "pass",
            },
        ],
    )
    _write_json(
        tmp_path,
        "eval_baseline.json",
        {"success_rate": 0.9, "saved_at": "2026-01-02T00:00:00"},
    )


def test_report_aggregates_all_seven_metrics(tmp_path):
    _write_full_dataset(tmp_path)
    report = agent_metrics_report()
    metrics = report["metrics"]

    assert report["schema_version"] == 1
    assert report["generated_at"]
    assert metrics["success_rate"] == {
        "value": 0.625,
        "n": 8,
        "source": "dogfood",
    }
    assert metrics["avg_tool_calls"] == {
        "value": 11.75,
        "n": 8,
        "source": "dogfood",
    }
    assert metrics["invalid_action_rate"] == {
        "value": round(6 / 55, 4),
        "tool_calls": 55,
        "failed": 6,
        "source": "dogfood",
    }
    assert metrics["first_attempt_success_rate"] == {
        "value": 0.5,
        "n": 6,
        "source": "longitudinal_dogfood",
    }
    recovery = metrics["recovery_success_rate"]
    assert recovery["value"] == round((1 / 3 + 0.5 + 0.5) / 3, 4)
    assert recovery["detail"]["task_level"] == {
        "value": round(1 / 3, 4),
        "recovered": 1,
        "first_failed": 3,
    }
    assert recovery["detail"]["hint_level"] == {
        "value": 0.5,
        "classes": 2,
        "total_attempts": 8,
    }
    assert recovery["detail"]["context_restore"] == {
        "value": 0.5,
        "verified": 1,
        "events": 2,
    }
    assert metrics["verification_coverage"] == {
        "value": 0.8,
        "wrote": 5,
        "verified": 4,
        "source": "dogfood",
    }
    assert metrics["verification_pass_rate"] == {"value": 0.75, "n": 4}
    patch = metrics["patch_regression_rate"]
    assert patch["value"] == 0.0
    assert patch["regressed"] == 0
    assert patch["total"] == 6
    assert patch["source"] == "longitudinal_dogfood"
    assert patch["regression_runs"] == {
        "runs": 2,
        "with_failures": 1,
        "rate": 0.5,
    }
    assert patch["eval_baseline"] == {
        "success_rate": 0.9,
        "saved_at": "2026-01-02T00:00:00",
    }

    sources = report["sources"]
    assert sources["dogfood"] == {"status": "ok", "rows": 8}
    assert sources["metrics_jsonl"] == {"status": "missing"}
    assert sources["self_correct_learning"] == {
        "status": "ok",
        "fingerprints": 2,
    }
    assert sources["recovery_outcomes"] == {"status": "ok", "rows": 2}
    assert sources["eval_baseline"] == {"status": "ok"}
    assert sources["regression_runs"] == {"status": "ok", "rows": 2}
    assert report["gates"]["formal_dogfood"] == "insufficient_evidence"
    assert report["gates"]["longitudinal_dogfood"] == "insufficient_evidence"


def test_invalid_action_rate_prefers_metrics_jsonl(tmp_path):
    _write_dogfood(
        tmp_path,
        [
            _base_row(task="t1", task_id="t1", suite_id="s1", success=True,
                      tool_calls=10, failed_tool_calls=1, modified_files=0),
        ],
    )
    _write_jsonl(
        tmp_path,
        "metrics.jsonl",
        [
            {"tool_calls": 100, "failed_tool_calls": 5},
            {"tool_calls": 100},
        ],
    )
    metric = agent_metrics_report()["metrics"]["invalid_action_rate"]
    assert metric == {
        "value": 0.05,
        "tool_calls": 100,
        "failed": 5,
        "source": "metrics_jsonl",
    }


def test_invalid_action_rate_none_without_failed_tool_calls_data(tmp_path):
    _write_dogfood(
        tmp_path,
        [
            _base_row(task="t1", task_id="t1", suite_id="s1", success=True,
                      tool_calls=10, modified_files=0),
        ],
    )
    metric = agent_metrics_report()["metrics"]["invalid_action_rate"]
    assert metric["value"] is None
    assert metric["tool_calls"] == 0
    assert metric["failed"] == 0
    assert metric["source"] is None
    assert "尚未落盘" in metric["note"]


def test_report_handles_missing_sources(tmp_path):
    report = agent_metrics_report()
    for key in _METRIC_KEYS:
        assert report["metrics"][key]["value"] is None
    assert report["metrics"]["recovery_success_rate"]["detail"]["task_level"][
        "value"
    ] is None
    assert all(source["status"] == "missing" for source in report["sources"].values())
    assert report["gates"]["formal_dogfood"] == "insufficient_evidence"
    assert report["gates"]["longitudinal_dogfood"] == "insufficient_evidence"


def test_recovery_fuses_available_sources(tmp_path):
    _write_dogfood(
        tmp_path,
        [
            _base_row(task="t1", task_id="t1", suite_id="s1", success=False,
                      tool_calls=10, modified_files=0,
                      verification_passed=False, verification={"ok": True}),
            _base_row(task="t1", task_id="t1", suite_id="s1", success=True,
                      tool_calls=10, modified_files=0,
                      verification_passed=True, verification={"ok": True}),
        ],
    )
    recovery = agent_metrics_report()["metrics"]["recovery_success_rate"]
    assert recovery["value"] == 1.0
    assert recovery["detail"]["task_level"] == {
        "value": 1.0,
        "recovered": 1,
        "first_failed": 1,
    }
    assert recovery["detail"]["hint_level"]["value"] is None
    assert recovery["detail"]["context_restore"]["value"] is None


def test_history_appends_and_reads_back(tmp_path):
    _write_dogfood(
        tmp_path,
        [
            _base_row(task="t1", task_id="t1", suite_id="s1", success=True,
                      tool_calls=10, modified_files=0),
        ],
    )
    entries = agent_metrics_history()
    assert len(entries) == 1
    entry = entries[0]
    assert entry["ts"]
    assert entry["schema_version"] == 1
    assert entry["metrics"]["success_rate"] == 1.0
    assert entry["sources"]["dogfood"] == "ok"
    assert entry["gates"]["formal_dogfood"] == "insufficient_evidence"

    again = agent_metrics_history(limit=1)
    assert len(again) == 1
    assert again[0]["metrics"]["success_rate"] == 1.0
    assert again[0]["ts"] != entry["ts"]
    history_file = _arforge_dir(tmp_path) / "agent_metrics.jsonl"
    assert history_file.is_file()
    assert len(history_file.read_text(encoding="utf-8").splitlines()) == 2


def test_clear_history_returns_row_count(tmp_path):
    _write_dogfood(
        tmp_path,
        [
            _base_row(task="t1", task_id="t1", suite_id="s1", success=True,
                      tool_calls=10, modified_files=0),
        ],
    )
    agent_metrics_history()
    agent_metrics_history()
    history_file = _arforge_dir(tmp_path) / "agent_metrics.jsonl"
    assert clear_agent_metrics_history() == 2
    assert not history_file.exists()
    assert clear_agent_metrics_history() == 0
