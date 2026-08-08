"""Agent 运行指标统一聚合层。

把分散在 dogfood.jsonl、metrics.jsonl、self_correct_learning.json、
recovery_outcomes.jsonl、eval_baseline.json、regression_runs.jsonl 中的
7 项 Agent 指标（成功率/平均工具调用/无效动作率/首次计划成功率/恢复成功率/
验证覆盖率/补丁回归率）聚合成单一报告，并把历史快照落到 agent_metrics.jsonl。
任何数据源缺失或异常都返回 0/None 值，绝不抛异常（遥测不能影响主流程）。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from arforge.core.dogfood import (
    formal_dogfood_report,
    load_outcomes,
    longitudinal_dogfood_report,
    stats,
)
from arforge.paths import data_path

_SCHEMA_VERSION = 1

_SOURCE_NAMES = (
    "dogfood",
    "metrics_jsonl",
    "self_correct_learning",
    "recovery_outcomes",
    "eval_baseline",
    "regression_runs",
)

_INVALID_ACTION_NO_DATA_NOTE = (
    "生产管道尚未落盘 failed_tool_calls（metrics.jsonl 与 dogfood.jsonl 均缺少该字段）"
)


def _arforge_home() -> Path:
    """返回当前 profile 目录（不创建）。"""
    return Path(os.environ.get("ARFORGE_HOME") or Path.home() / ".arforge")


def _dogfood_file() -> Path:
    return data_path("dogfood.jsonl")


def _metrics_file() -> Path:
    return data_path("metrics.jsonl")


def _eval_baseline_file() -> Path:
    return data_path("eval_baseline.json")


def _self_correct_file() -> Path:
    return _arforge_home() / "self_correct_learning.json"


def _recovery_outcomes_file() -> Path:
    return _arforge_home() / "recovery_outcomes.jsonl"


def _regression_runs_file() -> Path:
    return _arforge_home() / "regression_runs.jsonl"


def _history_file() -> Path:
    return _arforge_home() / "agent_metrics.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_jsonl(path: Path) -> list[dict]:
    """读取 jsonl 文件，坏行跳过；文件缺失或不可读返回空列表。"""
    if not path.is_file():
        return []
    rows: list[dict] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            rows.append(parsed)
    return rows


def _read_json(path: Path) -> dict:
    """读取 json 对象；文件缺失、不可读或非对象返回空 dict。"""
    if not path.is_file():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _success_rate(aggregate: dict) -> dict:
    total = int(aggregate.get("total", 0) or 0)
    return {
        "value": float(aggregate.get("success_rate", 0.0)) if total else None,
        "n": total,
        "source": "dogfood",
    }


def _avg_tool_calls(rows: list[dict]) -> dict:
    total = len(rows)
    calls = sum(int(row.get("tool_calls", 0) or 0) for row in rows)
    return {
        "value": round(calls / total, 2) if total else None,
        "n": total,
        "source": "dogfood",
    }


def _invalid_action_rate(
    metrics_rows: list[dict], dogfood_rows: list[dict]
) -> dict:
    """无效动作率：优先 metrics.jsonl，否则 dogfood 中同时含两字段的行。"""
    source: str | None = None
    rows: list[dict] = []
    preferred = [
        row
        for row in metrics_rows
        if "failed_tool_calls" in row and row.get("failed_tool_calls") is not None
    ]
    if preferred:
        source, rows = "metrics_jsonl", preferred
    else:
        fallback = [
            row
            for row in dogfood_rows
            if "failed_tool_calls" in row and row.get("failed_tool_calls") is not None
        ]
        if fallback:
            source, rows = "dogfood", fallback
    tool_calls = sum(int(row.get("tool_calls", 0) or 0) for row in rows)
    failed = sum(int(row.get("failed_tool_calls", 0) or 0) for row in rows)
    if source is None or tool_calls == 0:
        return {
            "value": None,
            "tool_calls": tool_calls,
            "failed": failed,
            "source": source,
            "note": _INVALID_ACTION_NO_DATA_NOTE,
        }
    return {
        "value": round(failed / tool_calls, 4),
        "tool_calls": tool_calls,
        "failed": failed,
        "source": source,
    }


def _first_attempt_success_rate(long_report: dict) -> dict:
    unique = int(long_report.get("unique_tasks", 0) or 0)
    return {
        "value": (
            float(long_report.get("first_attempt_success_rate", 0.0))
            if unique
            else None
        ),
        "n": unique,
        "source": "longitudinal_dogfood",
    }


def _recovery_success_rate(
    long_report: dict, self_correct: dict, recovery_rows: list[dict]
) -> dict:
    """恢复成功率：融合 task/hint/context_restore 三源，value 取有值子项平均。"""
    recovered = int(long_report.get("recovered_tasks", 0) or 0)
    first_failed = int(long_report.get("first_attempt_failed", 0) or 0)
    task_level = round(recovered / first_failed, 4) if first_failed else None
    detail = {
        "task_level": {
            "value": task_level,
            "recovered": recovered,
            "first_failed": first_failed,
        }
    }

    hint = self_correct.get("_hint_performance")
    success_total = 0
    failure_total = 0
    classes = 0
    if isinstance(hint, dict):
        for perf in hint.values():
            if not isinstance(perf, dict):
                continue
            classes += 1
            success_total += int(perf.get("success", 0) or 0)
            failure_total += int(perf.get("failure", 0) or 0)
    attempts_total = success_total + failure_total
    hint_level = round(success_total / attempts_total, 4) if attempts_total else None
    detail["hint_level"] = {
        "value": hint_level,
        "classes": classes,
        "total_attempts": attempts_total,
    }

    events = len(recovery_rows)
    verified = sum(1 for row in recovery_rows if bool(row.get("verified")))
    context_restore = round(verified / events, 4) if events else None
    detail["context_restore"] = {
        "value": context_restore,
        "verified": verified,
        "events": events,
    }

    values = [item["value"] for item in detail.values() if item["value"] is not None]
    return {
        "value": round(sum(values) / len(values), 4) if values else None,
        "detail": detail,
    }


def _verification_metrics(rows: list[dict]) -> tuple[dict, dict]:
    """验证覆盖率与验证通过率（基于修改过文件的行）。"""

    def has_verification(row: dict) -> bool:
        verification = row.get("verification")
        return (isinstance(verification, dict) and bool(verification)) or bool(
            row.get("verification_passed")
        )

    wrote = [row for row in rows if int(row.get("modified_files", 0) or 0) > 0]
    verified = [row for row in wrote if has_verification(row)]
    passed = sum(1 for row in verified if bool(row.get("verification_passed")))
    return (
        {
            "value": round(len(verified) / len(wrote), 4) if wrote else None,
            "wrote": len(wrote),
            "verified": len(verified),
            "source": "dogfood",
        },
        {
            "value": round(passed / len(verified), 4) if verified else None,
            "n": len(verified),
        },
    )


def _patch_regression_rate(
    long_report: dict, regression_rows: list[dict], eval_baseline: dict
) -> dict:
    """补丁回归率：longitudinal 回归占比，附 regression_runs 与 eval_baseline 信息。"""
    regressed = int(long_report.get("regressed_tasks", 0) or 0)
    unique = int(long_report.get("unique_tasks", 0) or 0)
    result = {
        "value": round(regressed / unique, 4) if unique else None,
        "regressed": regressed,
        "total": unique,
        "source": "longitudinal_dogfood",
    }
    if regression_rows:
        with_failures = sum(
            1 for row in regression_rows if int(row.get("failed", 0) or 0) > 0
        )
        result["regression_runs"] = {
            "runs": len(regression_rows),
            "with_failures": with_failures,
            "rate": round(with_failures / len(regression_rows), 4),
        }
    if eval_baseline:
        baseline: dict = {}
        if "success_rate" in eval_baseline:
            baseline["success_rate"] = eval_baseline.get("success_rate")
        saved_at = eval_baseline.get("saved_at")
        if saved_at is None:
            saved_at = eval_baseline.get("ts")
        if saved_at is not None:
            baseline["saved_at"] = saved_at
        if baseline:
            result["eval_baseline"] = baseline
    return result


def _fingerprint_count(self_correct: dict) -> int:
    return sum(1 for key in self_correct if key != "_hint_performance")


def _sources_summary(
    dogfood_rows: list[dict],
    metrics_rows: list[dict],
    self_correct: dict,
    recovery_rows: list[dict],
    eval_baseline: dict,
    regression_rows: list[dict],
) -> dict:
    return {
        "dogfood": (
            {"status": "ok", "rows": len(dogfood_rows)}
            if _dogfood_file().is_file()
            else {"status": "missing"}
        ),
        "metrics_jsonl": (
            {"status": "ok", "rows": len(metrics_rows)}
            if _metrics_file().is_file()
            else {"status": "missing"}
        ),
        "self_correct_learning": (
            {"status": "ok", "fingerprints": _fingerprint_count(self_correct)}
            if _self_correct_file().is_file()
            else {"status": "missing"}
        ),
        "recovery_outcomes": (
            {"status": "ok", "rows": len(recovery_rows)}
            if _recovery_outcomes_file().is_file()
            else {"status": "missing"}
        ),
        "eval_baseline": (
            {"status": "ok"} if _eval_baseline_file().is_file() else {"status": "missing"}
        ),
        "regression_runs": (
            {"status": "ok", "rows": len(regression_rows)}
            if _regression_runs_file().is_file()
            else {"status": "missing"}
        ),
    }


def _empty_metrics() -> dict:
    return {
        "success_rate": {"value": None, "n": 0, "source": "dogfood"},
        "avg_tool_calls": {"value": None, "n": 0, "source": "dogfood"},
        "invalid_action_rate": {
            "value": None,
            "tool_calls": 0,
            "failed": 0,
            "source": None,
            "note": _INVALID_ACTION_NO_DATA_NOTE,
        },
        "first_attempt_success_rate": {
            "value": None,
            "n": 0,
            "source": "longitudinal_dogfood",
        },
        "recovery_success_rate": {
            "value": None,
            "detail": {
                "task_level": {"value": None, "recovered": 0, "first_failed": 0},
                "hint_level": {"value": None, "classes": 0, "total_attempts": 0},
                "context_restore": {"value": None, "verified": 0, "events": 0},
            },
        },
        "verification_coverage": {
            "value": None,
            "wrote": 0,
            "verified": 0,
            "source": "dogfood",
        },
        "verification_pass_rate": {"value": None, "n": 0},
        "patch_regression_rate": {
            "value": None,
            "regressed": 0,
            "total": 0,
            "source": "longitudinal_dogfood",
        },
    }


def _build_report() -> dict:
    dogfood_rows = load_outcomes()
    metrics_rows = _read_jsonl(_metrics_file())
    self_correct = _read_json(_self_correct_file())
    recovery_rows = _read_jsonl(_recovery_outcomes_file())
    regression_rows = _read_jsonl(_regression_runs_file())
    eval_baseline = _read_json(_eval_baseline_file())

    formal_report = formal_dogfood_report()
    long_report = longitudinal_dogfood_report()
    verification_coverage, verification_pass_rate = _verification_metrics(dogfood_rows)

    metrics = {
        "success_rate": _success_rate(stats()),
        "avg_tool_calls": _avg_tool_calls(dogfood_rows),
        "invalid_action_rate": _invalid_action_rate(metrics_rows, dogfood_rows),
        "first_attempt_success_rate": _first_attempt_success_rate(long_report),
        "recovery_success_rate": _recovery_success_rate(
            long_report, self_correct, recovery_rows
        ),
        "verification_coverage": verification_coverage,
        "verification_pass_rate": verification_pass_rate,
        "patch_regression_rate": _patch_regression_rate(
            long_report, regression_rows, eval_baseline
        ),
    }
    return {
        "schema_version": _SCHEMA_VERSION,
        "generated_at": _now_iso(),
        "metrics": metrics,
        "sources": _sources_summary(
            dogfood_rows,
            metrics_rows,
            self_correct,
            recovery_rows,
            eval_baseline,
            regression_rows,
        ),
        "gates": {
            "formal_dogfood": formal_report["status"],
            "longitudinal_dogfood": long_report["status"],
        },
    }


def agent_metrics_report() -> dict:
    """聚合 7 项 Agent 指标为单一报告；任何源缺失/异常都返回 0/None，绝不抛异常。"""
    try:
        return _build_report()
    except Exception as exc:
        return {
            "schema_version": _SCHEMA_VERSION,
            "generated_at": _now_iso(),
            "metrics": _empty_metrics(),
            "sources": {
                name: {"status": "error"} for name in _SOURCE_NAMES
            },
            "gates": {
                "formal_dogfood": "insufficient_evidence",
                "longitudinal_dogfood": "insufficient_evidence",
            },
            "error": str(exc),
        }


def agent_metrics_history(limit: int = 50) -> list[dict]:
    """追加一条指标快照到 agent_metrics.jsonl 并读回最近 limit 条；写失败静默。"""
    limit = max(0, int(limit))
    report = agent_metrics_report()
    entry = {
        "ts": report["generated_at"],
        "schema_version": _SCHEMA_VERSION,
        "metrics": {
            name: metric.get("value") for name, metric in report["metrics"].items()
        },
        "sources": {
            name: source.get("status") for name, source in report["sources"].items()
        },
        "gates": report["gates"],
    }
    try:
        f = _history_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        with f.open("a", encoding="utf-8") as h:
            h.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return _read_jsonl(_history_file())[-limit:] if limit else []


def clear_agent_metrics_history() -> int:
    """删除 agent_metrics.jsonl 并返回被删除的行数。"""
    f = _history_file()
    if not f.is_file():
        return 0
    try:
        count = len(_read_jsonl(f))
        f.unlink()
        return count
    except OSError:
        return 0
