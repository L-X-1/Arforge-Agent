"""补丁回归率统计管道：记录每次回归测试运行，聚合历史回归率。

每次 run_impacted_tests 落一行到 ``{ARFORGE_HOME}/regression_runs.jsonl``
（用户级 JSONL），供 agent / CLI 查询"改动的回归率"；eval 基线状态
（eval_baseline.json）也在此提供统一读取入口。
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from arforge.core.eval_baseline import load_baseline
from arforge.paths import data_path, get_arforge_home

_RUNS_FILE = "regression_runs.jsonl"
_FILE_MAX = 200
_SUMMARY_MAX = 300
_TREND_DAYS = 7


def _runs_path() -> Path:
    return get_arforge_home() / _RUNS_FILE


def record_regression_run(changed_files: list[str], result: dict, *, workspace: str = "") -> None:
    """把一次回归测试运行追加到 regression_runs.jsonl（写失败静默）。

    workspace 仅用于去重统计：只存其哈希前 16 位，不落盘明文路径。
    """
    try:
        files = [str(f)[:_FILE_MAX] for f in (changed_files or [])]
        ran = bool(result.get("ran"))
        failed = int(result.get("failed") or 0)
        row = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "files": files,
            "workspace_scope": (
                hashlib.sha1(str(workspace).encode("utf-8")).hexdigest()[:16] if workspace else ""
            ),
            "ran": ran,
            "passed": int(result.get("passed") or 0),
            "failed": failed,
            "returncode": int(result.get("returncode") or 0),
            "summary": str(result.get("summary") or "")[:_SUMMARY_MAX],
            "regression": ran and failed > 0,
        }
        path = _runs_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    except (OSError, ValueError, TypeError):
        pass


def _parse_row(line: str) -> dict[str, Any] | None:
    """解析一行 JSONL；损坏（含 ts 无法解析）返回 None。"""
    try:
        row = json.loads(line)
        if not isinstance(row, dict):
            return None
        datetime.fromisoformat(str(row["ts"]).replace("Z", "+00:00"))
        return row
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None


def regression_rate_report() -> dict:
    """聚合历史回归运行：总数、失败率与最近 7 天趋势（缺文件不抛）。"""
    rows: list[dict[str, Any]] = []
    corrupt_rows = 0
    path = _runs_path()
    if path.exists():
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            text = ""
        for line in text.splitlines():
            if not line.strip():
                continue
            parsed = _parse_row(line)
            if parsed is None:
                corrupt_rows += 1
            else:
                rows.append(parsed)

    runs_total = len(rows)
    with_failures = sum(1 for r in rows if r.get("regression"))
    passed_total = sum(int(r.get("passed") or 0) for r in rows)
    failed_total = sum(int(r.get("failed") or 0) for r in rows)

    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=_TREND_DAYS - 1)
    per_day: dict[Any, list[int]] = defaultdict(lambda: [0, 0])
    for r in rows:
        day = datetime.fromisoformat(str(r["ts"]).replace("Z", "+00:00")).date()
        per_day[day][0] += 1
        if r.get("regression"):
            per_day[day][1] += 1
    daily_trend = []
    for i in range(_TREND_DAYS):
        day = start + timedelta(days=i)
        runs, regressions = per_day.get(day, (0, 0))
        daily_trend.append(
            {
                "date": day.isoformat(),
                "runs": runs,
                "regression": regressions,
                "rate": (regressions / runs if runs else None),
            }
        )

    last_run = None
    if rows:
        last_run = {"ts": rows[-1]["ts"], "regression": bool(rows[-1].get("regression"))}
    return {
        "runs_total": runs_total,
        "with_failures": with_failures,
        "regression_rate": (with_failures / runs_total if runs_total else None),
        "passed_total": passed_total,
        "failed_total": failed_total,
        "last_run": last_run,
        "daily_trend": daily_trend,
        "corrupt_rows": corrupt_rows,
    }


def clear_regression_metrics() -> int:
    """删除回归运行记录文件，返回删除的记录行数（文件缺失返回 0）。"""
    path = _runs_path()
    try:
        if not path.exists():
            return 0
        count = sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
        path.unlink()
        return count
    except OSError:
        return 0


def eval_baseline_status() -> dict:
    """读取 eval 基线状态：存在性、成功率与任务数（不存在/损坏不抛）。"""
    path = data_path("eval_baseline.json")
    if not path.exists():
        return {"exists": False}
    baseline = load_baseline()
    if baseline is None:
        return {"exists": True, "error": f"基线文件存在但无法解析: {path}"}
    per_task = baseline.get("per_task") if isinstance(baseline.get("per_task"), dict) else {}
    return {
        "exists": True,
        "success_rate": baseline.get("success_rate"),
        "passed": baseline.get("passed"),
        "total": baseline.get("total"),
        "saved_at": baseline.get("saved_at", ""),
        "task_count": len(per_task),
    }
