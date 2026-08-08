"""补丁回归率统计（regression_metrics）测试。"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone

import pytest

from arforge.core.eval_baseline import save_baseline
from arforge.core.regression_metrics import (
    clear_regression_metrics,
    eval_baseline_status,
    record_regression_run,
    regression_rate_report,
)


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    yield


def _runs_file():
    from arforge.core.regression_metrics import _runs_path

    return _runs_path()


def _lines():
    p = _runs_file()
    if not p.exists():
        return []
    return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]


def _row(ts: str, passed: int, failed: int) -> str:
    return json.dumps(
        {
            "ts": ts,
            "files": ["foo.py"],
            "workspace_scope": "",
            "ran": True,
            "passed": passed,
            "failed": failed,
            "returncode": 1 if failed else 0,
            "summary": "x",
            "regression": failed > 0,
        },
        ensure_ascii=False,
    )


def _today_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# -- record_regression_run ---------------------------------------------------


def test_record_writes_valid_line(tmp_path):
    record_regression_run(
        ["src/foo.py", "src/bar.py"],
        {"ran": True, "passed": 2, "failed": 1, "returncode": 1, "summary": "1 failed, 2 passed"},
        workspace=str(tmp_path),
    )
    rows = _lines()
    assert len(rows) == 1
    row = rows[0]
    assert row["ts"].endswith("Z")
    assert row["files"] == ["src/foo.py", "src/bar.py"]
    assert len(row["workspace_scope"]) == 16
    assert row["workspace_scope"] == hashlib.sha1(str(tmp_path).encode("utf-8")).hexdigest()[:16]
    assert row["ran"] is True
    assert row["passed"] == 2
    assert row["failed"] == 1
    assert row["returncode"] == 1
    assert row["regression"] is True


def test_record_success_run_is_not_regression():
    record_regression_run(
        ["foo.py"], {"ran": True, "passed": 3, "failed": 0, "returncode": 0, "summary": "3 passed"}
    )
    row = _lines()[0]
    assert row["regression"] is False
    assert row["workspace_scope"] == ""


def test_record_truncates_long_values():
    record_regression_run(
        ["a" * 300],
        {"ran": True, "passed": 0, "failed": 0, "returncode": 0, "summary": "s" * 500},
    )
    row = _lines()[0]
    assert len(row["files"][0]) == 200
    assert len(row["summary"]) == 300


# -- regression_rate_report --------------------------------------------------


def test_regression_rate_report_aggregation():
    ts = _today_ts()
    p = _runs_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "\n".join([_row(ts, 3, 2), _row(ts, 4, 1), _row(ts, 5, 0)]) + "\n", encoding="utf-8"
    )

    rep = regression_rate_report()
    assert rep["runs_total"] == 3
    assert rep["with_failures"] == 2
    assert rep["regression_rate"] == pytest.approx(2 / 3)
    assert rep["passed_total"] == 12
    assert rep["failed_total"] == 3
    assert rep["last_run"] == {"ts": ts, "regression": False}

    today = datetime.now(timezone.utc).date().isoformat()
    trend = {d["date"]: d for d in rep["daily_trend"]}
    assert len(rep["daily_trend"]) == 7
    assert trend[today]["runs"] == 3
    assert trend[today]["regression"] == 2
    assert trend[today]["rate"] == pytest.approx(2 / 3)
    assert all(trend[d]["runs"] == 0 and trend[d]["rate"] is None for d in trend if d != today)


def test_daily_trend_includes_past_days():
    d3 = (datetime.now(timezone.utc) - timedelta(days=3)).date()
    ts = d3.isoformat() + "T10:00:00Z"
    p = _runs_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(_row(ts, 1, 1) + "\n", encoding="utf-8")

    rep = regression_rate_report()
    assert rep["runs_total"] == 1
    assert rep["regression_rate"] == 1.0
    trend = {d["date"]: d for d in rep["daily_trend"]}
    assert trend[d3.isoformat()] == {"date": d3.isoformat(), "runs": 1, "regression": 1, "rate": 1.0}


def test_report_missing_file_returns_zeros():
    rep = regression_rate_report()
    assert rep["runs_total"] == 0
    assert rep["with_failures"] == 0
    assert rep["regression_rate"] is None
    assert rep["passed_total"] == 0
    assert rep["failed_total"] == 0
    assert rep["last_run"] is None
    assert len(rep["daily_trend"]) == 7
    assert all(d["runs"] == 0 and d["regression"] == 0 and d["rate"] is None for d in rep["daily_trend"])
    assert rep["corrupt_rows"] == 0


def test_report_skips_corrupt_rows():
    p = _runs_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{"bad json"\n' + _row(_today_ts(), 2, 0) + "\nnot json\n", encoding="utf-8")

    rep = regression_rate_report()
    assert rep["corrupt_rows"] == 2
    assert rep["runs_total"] == 1
    assert rep["with_failures"] == 0
    assert rep["passed_total"] == 2


def test_clear_removes_file_and_returns_count():
    p = _runs_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        _row("2026-01-01T00:00:00Z", 1, 0) + "\n" + _row("2026-01-02T00:00:00Z", 0, 1) + "\n",
        encoding="utf-8",
    )
    assert clear_regression_metrics() == 2
    assert not p.exists()
    assert clear_regression_metrics() == 0


# -- eval_baseline_status ----------------------------------------------------


def test_eval_baseline_status_missing():
    assert eval_baseline_status() == {"exists": False}


def test_eval_baseline_status_present():
    from arforge.eval import EvalCase, EvalReport

    r = EvalReport()
    r.cases.append(EvalCase(task_id="a", success=True))
    r.cases.append(EvalCase(task_id="b", success=False))
    save_baseline(r)

    st = eval_baseline_status()
    assert st["exists"] is True
    assert st["success_rate"] == 0.5
    assert st["passed"] == 1
    assert st["total"] == 2
    assert st["task_count"] == 2
    assert "saved_at" in st


def test_eval_baseline_status_corrupt():
    from arforge.paths import data_path

    p = data_path("eval_baseline.json")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("{broken", encoding="utf-8")

    st = eval_baseline_status()
    assert st["exists"] is True
    assert "error" in st


# -- regression_tools 接线 ---------------------------------------------------


def test_run_impacted_tests_records_metrics(tmp_path, monkeypatch):
    import arforge.tools.file_tools as ft
    import arforge.tools.regression_tools  # noqa: F401  触发注册
    from arforge.core.change_tracker import change_tracker_scope
    from arforge.tool_registry import REGISTRY

    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "foo.py").write_text("", encoding="utf-8")
    (ws / "test_foo.py").write_text("def test_ok():\n    assert True\n", encoding="utf-8")

    monkeypatch.setattr(ft, "get_workspace", lambda: ws)
    monkeypatch.setattr(
        "arforge.core.regression.run_pytest",
        lambda test_files, workspace, timeout=120: {
            "ran": True,
            "passed": 1,
            "failed": 0,
            "returncode": 0,
            "summary": "1 passed",
        },
    )

    with change_tracker_scope():
        from arforge.core.change_tracker import get_change_tracker

        get_change_tracker().record("foo.py")
        res = REGISTRY.execute_by_name("run_impacted_tests", {})
        assert res.success
        assert "1 passed" in res.output

    rows = _lines()
    assert len(rows) == 1
    assert rows[0]["files"] == ["foo.py"]
    assert rows[0]["ran"] is True
    assert rows[0]["passed"] == 1
    assert rows[0]["regression"] is False
    assert rows[0]["workspace_scope"] == hashlib.sha1(str(ws).encode("utf-8")).hexdigest()[:16]
