"""EvalReport 经济性派生指标测试（单位成本/单位延迟成功率等）。"""

from __future__ import annotations

from arforge.eval.report import EvalCase, EvalReport

LEGACY_REPORT_KEYS = [
    "suite",
    "total",
    "passed",
    "success_rate",
    "avg_score",
    "total_tokens",
    "total_cost_cny",
]

LEGACY_CASE_KEYS = [
    "task_id",
    "category",
    "success",
    "steps",
    "tokens",
    "error",
    "judge_reason",
    "answer",
    "score",
    "artifact_path",
    "token_budget",
]


def _case(task_id, category, success, tokens=0, cost_cny=0.0, elapsed_sec=0.0):
    return EvalCase(
        task_id=task_id,
        category=category,
        success=success,
        tokens=tokens,
        cost_cny=cost_cny,
        elapsed_sec=elapsed_sec,
    )


def test_derived_economics_metrics_hand_computed():
    cases = [
        _case("a", "code", True, tokens=100, cost_cny=0.010, elapsed_sec=5.0),
        _case("b", "code", False, tokens=300, cost_cny=0.020, elapsed_sec=15.0),
    ]
    r = EvalReport(
        suite="core",
        cases=cases,
        total=2,
        passed=1,
        success_rate=0.5,
        total_tokens=400,
        total_cost_cny=0.030,
        total_elapsed_sec=20.0,
    )
    d = r.to_dict()
    assert d["total_cost_cny"] == 0.030
    assert d["total_elapsed_sec"] == 20.0
    assert d["success_per_cost_cny"] == round(1 / 0.03, 6)
    assert d["success_per_elapsed_sec"] == 0.05
    assert d["cost_cny_per_success"] == 0.03
    assert d["tokens_per_success"] == 400
    assert d["cases"][0]["cost_cny"] == 0.010
    assert d["cases"][0]["elapsed_sec"] == 5.0


def test_derived_metrics_none_when_passed_zero():
    r = EvalReport(total=2, passed=0, total_tokens=0, total_cost_cny=0.0, total_elapsed_sec=0.0)
    d = r.to_dict()
    assert d["success_per_cost_cny"] is None
    assert d["success_per_elapsed_sec"] is None
    assert d["cost_cny_per_success"] is None
    assert d["tokens_per_success"] is None


def test_success_per_cost_none_when_cost_zero():
    r = EvalReport(total=1, passed=1, total_tokens=10, total_cost_cny=0.0, total_elapsed_sec=3.0)
    d = r.to_dict()
    assert d["success_per_cost_cny"] is None
    assert d["success_per_elapsed_sec"] == round(1 / 3.0, 6)
    assert d["cost_cny_per_success"] == 0.0
    assert d["tokens_per_success"] == 10


def test_by_category_aggregation():
    cases = [
        _case("c1", "code", True, tokens=100, cost_cny=0.01, elapsed_sec=5.0),
        _case("c2", "code", False, tokens=200, cost_cny=0.02, elapsed_sec=10.0),
        _case("c3", "code", True, tokens=300, cost_cny=0.03, elapsed_sec=15.0),
        _case("d1", "doc", True, tokens=50, cost_cny=0.005, elapsed_sec=2.0),
        _case("r1", "retrieval", False, tokens=700, cost_cny=0.07, elapsed_sec=21.0),
        _case("r2", "retrieval", False, tokens=200, cost_cny=0.02, elapsed_sec=6.0),
    ]
    r = EvalReport(cases=cases)
    d = r.to_dict()
    bc = d["by_category"]
    assert set(bc) == {"code", "doc", "retrieval"}
    assert bc["code"] == {
        "total": 3,
        "passed": 2,
        "success_rate": round(2 / 3, 3),
        "tokens": 600,
        "cost_cny": 0.06,
        "elapsed_sec": 30.0,
    }
    assert bc["doc"] == {
        "total": 1,
        "passed": 1,
        "success_rate": 1.0,
        "tokens": 50,
        "cost_cny": 0.005,
        "elapsed_sec": 2.0,
    }
    assert bc["retrieval"] == {
        "total": 2,
        "passed": 0,
        "success_rate": 0.0,
        "tokens": 900,
        "cost_cny": 0.09,
        "elapsed_sec": 27.0,
    }
    assert r.by_category_summary() == d["by_category"]


def test_legacy_cases_without_cost_elapsed():
    r = EvalReport()
    r.cases.append(EvalCase(task_id="old-1", category="code", success=True))
    r.cases.append(EvalCase(task_id="old-2", category="", success=False))
    r.total = 2
    r.passed = 1
    d = r.to_dict()
    assert d["cases"][0]["cost_cny"] == 0.0
    assert d["cases"][0]["elapsed_sec"] == 0.0
    assert d["cases"][1]["cost_cny"] == 0.0
    assert d["total_elapsed_sec"] == 0.0
    assert d["success_per_cost_cny"] is None
    assert d["by_category"]["code"]["passed"] == 1
    assert d["by_category"]["unknown"]["total"] == 1


def test_existing_field_order_preserved():
    r = EvalReport(
        cases=[_case("a", "code", True, tokens=10, cost_cny=0.001, elapsed_sec=1.0)]
    )
    d = r.to_dict()
    keys = list(d)
    assert keys[: len(LEGACY_REPORT_KEYS)] == LEGACY_REPORT_KEYS
    assert d["by_category"] == {
        "code": {
            "total": 1,
            "passed": 1,
            "success_rate": 1.0,
            "tokens": 10,
            "cost_cny": 0.001,
            "elapsed_sec": 1.0,
        }
    }
    case_keys = list(d["cases"][0])
    assert case_keys[: len(LEGACY_CASE_KEYS)] == LEGACY_CASE_KEYS
    assert case_keys[-2:] == ["cost_cny", "elapsed_sec"]
