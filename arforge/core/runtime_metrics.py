"""Runtime metrics dashboard — cost, token, and success tracking for ``arforge stats``.

T11: Observable dashboard providing:
  - Session-level token/cost/success tracking
  - ``arforge stats`` CLI command
  - JSON report output
  - Integration with run_report hooks
"""

from __future__ import annotations

import json
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from arforge.paths import data_path


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class RunMetrics:
    """Per-run metrics collected during a code agent execution."""

    task: str = ""
    success: bool = False
    steps: int = 0
    tool_calls: int = 0
    llm_calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    tokens_total: int = 0
    cost_cny: float = 0.0
    elapsed_ms: float = 0.0
    explored_files: int = 0
    modified_files: int = 0
    commands_run: int = 0
    verifications: int = 0
    complexity_tier: str = ""
    self_correct_attempts: int = 0
    run_id: str = ""
    ts: str = ""

    def to_dict(self) -> dict:
        return {
            "task": self.task,
            "success": self.success,
            "steps": self.steps,
            "tool_calls": self.tool_calls,
            "llm_calls": self.llm_calls,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "tokens_total": self.tokens_total,
            "cost_cny": round(self.cost_cny, 4),
            "elapsed_ms": round(self.elapsed_ms, 1),
            "explored_files": self.explored_files,
            "modified_files": self.modified_files,
            "commands_run": self.commands_run,
            "verifications": self.verifications,
            "complexity_tier": self.complexity_tier,
            "self_correct_attempts": self.self_correct_attempts,
            "run_id": self.run_id,
            "ts": self.ts,
        }


@dataclass
class SessionSummary:
    """Aggregated session statistics."""

    total_runs: int = 0
    successful_runs: int = 0
    failed_runs: int = 0
    success_rate: float = 0.0
    total_tokens: int = 0
    total_cost_cny: float = 0.0
    total_steps: int = 0
    avg_steps_per_run: float = 0.0
    avg_tokens_per_run: float = 0.0
    total_elapsed_ms: float = 0.0
    total_files_explored: int = 0
    total_files_modified: int = 0
    total_commands: int = 0
    complexity_distribution: dict[str, int] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Metrics collector
# ---------------------------------------------------------------------------


class MetricsCollector:
    """Thread-safe session-level metrics collector."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._runs: list[RunMetrics] = []
        self._started_at = time.time()

    def record_run(self, metrics: RunMetrics) -> None:
        if not metrics.ts:
            metrics.ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with self._lock:
            self._runs.append(metrics)
        self._persist(metrics)

    def _persist(self, metrics: RunMetrics) -> None:
        """Append to metrics.jsonl for persistent tracking."""
        try:
            f = data_path("metrics.jsonl")
            f.parent.mkdir(parents=True, exist_ok=True)
            with f.open("a", encoding="utf-8") as h:
                h.write(json.dumps(metrics.to_dict(), ensure_ascii=False) + "\n")
        except OSError:
            pass

    def load_history(self) -> list[dict]:
        """Load all historical metrics from disk."""
        f = data_path("metrics.jsonl")
        if not f.is_file():
            return []
        rows = []
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return rows

    def summary(self) -> SessionSummary:
        """Compute session summary from in-memory runs."""
        with self._lock:
            runs = list(self._runs)

        if not runs:
            return SessionSummary()

        total = len(runs)
        ok = sum(1 for r in runs if r.success)

        complexity_dist: dict[str, int] = {}
        for r in runs:
            tier = r.complexity_tier or "unknown"
            complexity_dist[tier] = complexity_dist.get(tier, 0) + 1

        return SessionSummary(
            total_runs=total,
            successful_runs=ok,
            failed_runs=total - ok,
            success_rate=round(ok / total, 3) if total else 0.0,
            total_tokens=sum(r.tokens_total for r in runs),
            total_cost_cny=round(sum(r.cost_cny for r in runs), 4),
            total_steps=sum(r.steps for r in runs),
            avg_steps_per_run=round(sum(r.steps for r in runs) / total, 1) if total else 0.0,
            avg_tokens_per_run=round(sum(r.tokens_total for r in runs) / total, 1) if total else 0.0,
            total_elapsed_ms=sum(r.elapsed_ms for r in runs),
            total_files_explored=sum(r.explored_files for r in runs),
            total_files_modified=sum(r.modified_files for r in runs),
            total_commands=sum(r.commands_run for r in runs),
            complexity_distribution=complexity_dist,
        )

    def render(self) -> str:
        """Render a human-readable dashboard."""
        s = self.summary()

        if s.total_runs == 0:
            return "No runs recorded yet. Run `arforge code` to start."

        bar_len = 20
        filled = int(bar_len * s.success_rate) if s.success_rate else 0
        bar = "█" * filled + "░" * (bar_len - filled)

        lines = [
            "╔══════════════════════════════════════════╗",
            "║        Arforge Agent — Run Stats         ║",
            "╚══════════════════════════════════════════╝",
            "",
            f"  Runs:        {s.total_runs} total ({s.successful_runs} OK, {s.failed_runs} FAIL)",
            f"  Success:     {s.success_rate:.0%}  [{bar}]",
            f"  Steps:       {s.total_steps} total, {s.avg_steps_per_run} avg/run",
            f"  Tokens:      {s.total_tokens:,} total, {s.avg_tokens_per_run:,.0f} avg/run",
            f"  Cost:        ¥{s.total_cost_cny:.4f}",
            f"  Time:        {s.total_elapsed_ms/1000:.1f}s total",
            f"  Files read:  {s.total_files_explored}",
            f"  Files mod:   {s.total_files_modified}",
            f"  Commands:    {s.total_commands}",
        ]

        if s.complexity_distribution:
            lines.append("")
            lines.append("  Complexity distribution:")
            for tier in ("simple", "medium", "complex", "unknown"):
                count = s.complexity_distribution.get(tier, 0)
                if count:
                    lines.append(f"    {tier}: {count}")

        return "\n".join(lines)

    def render_json(self) -> str:
        """Render summary as JSON."""
        s = self.summary()
        return json.dumps(
            {
                "total_runs": s.total_runs,
                "successful_runs": s.successful_runs,
                "failed_runs": s.failed_runs,
                "success_rate": s.success_rate,
                "total_tokens": s.total_tokens,
                "total_cost_cny": s.total_cost_cny,
                "total_steps": s.total_steps,
                "avg_steps_per_run": s.avg_steps_per_run,
                "avg_tokens_per_run": s.avg_tokens_per_run,
                "total_elapsed_ms": s.total_elapsed_ms,
                "total_files_explored": s.total_files_explored,
                "total_files_modified": s.total_files_modified,
                "total_commands": s.total_commands,
                "complexity_distribution": s.complexity_distribution,
                "history_count": len(self.load_history()),
            },
            ensure_ascii=False,
            indent=2,
        )

    def reset(self) -> None:
        with self._lock:
            self._runs.clear()
            self._started_at = time.time()


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------


_collector: MetricsCollector | None = None
_lock = threading.Lock()


def get_metrics() -> MetricsCollector:
    global _collector
    if _collector is None:
        with _lock:
            if _collector is None:
                _collector = MetricsCollector()
    return _collector


def reset_metrics() -> None:
    global _collector
    with _lock:
        _collector = MetricsCollector()


def build_runtime_metrics(
    *,
    window_hours: int = 24,
    bucket: str = "hour",
    limit: int = 500,
) -> dict:
    """Build the structured telemetry contract used by desktop dashboards."""
    window_hours = max(1, min(int(window_hours), 24 * 90))
    limit = max(1, min(int(limit), 5000))
    if bucket not in {"hour", "day"}:
        bucket = "hour"

    now = datetime.now()
    cutoff = now - timedelta(hours=window_hours)
    issues = {"tokens": None, "dogfood": None}
    try:
        from arforge.models.token_tracker import list_token_usage

        token_rows = list_token_usage(limit=limit)
    except Exception as exc:  # noqa: BLE001 - dashboard must degrade instead of failing
        token_rows = []
        issues["tokens"] = str(exc)
    try:
        from arforge.core.dogfood import load_outcomes

        dogfood_rows = load_outcomes()[-limit:]
    except Exception as exc:  # noqa: BLE001 - dashboard must degrade instead of failing
        dogfood_rows = []
        issues["dogfood"] = str(exc)

    recent_tokens: list[dict] = []
    for row in token_rows:
        ts = _parse_metric_ts(row.get("created_at"))
        if ts is not None and ts < cutoff:
            continue
        recent_tokens.append(row)

    recent_dogfood: list[dict] = []
    for row in dogfood_rows:
        ts = _parse_metric_ts(row.get("ts"))
        if ts is not None and ts < cutoff:
            continue
        recent_dogfood.append(row)

    prompt_tokens = sum(_as_int(row.get("prompt_tokens")) for row in recent_tokens)
    completion_tokens = sum(_as_int(row.get("completion_tokens")) for row in recent_tokens)
    total_tokens = sum(_as_int(row.get("total_tokens")) for row in recent_tokens)
    cache_hits = sum(_as_int(row.get("prompt_cache_hit_tokens")) for row in recent_tokens)
    cache_misses = sum(_as_int(row.get("prompt_cache_miss_tokens")) for row in recent_tokens)
    cache_total = cache_hits + cache_misses
    def explicit_cost(row: dict) -> float | None:
        if "estimated_cost_cny" in row and row.get("estimated_cost_cny") is not None:
            return _as_float(row.get("estimated_cost_cny"))
        if "cost_cny" in row and row.get("cost_cny") is not None:
            return _as_float(row.get("cost_cny"))
        return None

    priced_calls = sum(1 for row in recent_tokens if explicit_cost(row) is not None)
    unpriced_calls = len(recent_tokens) - priced_calls
    cost_status = "available" if recent_tokens and unpriced_calls == 0 else ("partial" if priced_calls else "unavailable")
    estimated_cost = (
        round(sum(explicit_cost(row) or 0.0 for row in recent_tokens), 6)
        if cost_status == "available"
        else None
    )

    by_model: dict[str, dict] = {}
    series: dict[str, dict] = defaultdict(
        lambda: {
            "calls": 0,
            "total_tokens": 0,
            "estimated_cost_cny": 0.0,
            "priced_calls": 0,
            "dogfood_total": 0,
            "dogfood_failed": 0,
        }
    )
    for row in recent_tokens:
        model = str(row.get("model") or row.get("model_name") or "unknown")
        model_row = by_model.setdefault(
            model,
            {
                "model": model,
                "calls": 0,
                "total_tokens": 0,
                "prompt_cache_hit_tokens": 0,
                "prompt_cache_miss_tokens": 0,
                "estimated_cost_cny": 0.0,
                "priced_calls": 0,
            },
        )
        model_row["calls"] += 1
        model_row["total_tokens"] += _as_int(row.get("total_tokens"))
        model_row["prompt_cache_hit_tokens"] += _as_int(row.get("prompt_cache_hit_tokens"))
        model_row["prompt_cache_miss_tokens"] += _as_int(row.get("prompt_cache_miss_tokens"))
        row_cost = explicit_cost(row)
        if row_cost is not None:
            model_row["priced_calls"] += 1
            model_row["estimated_cost_cny"] = round(model_row["estimated_cost_cny"] + row_cost, 6)

        slot = _bucket_key(_parse_metric_ts(row.get("created_at")), bucket)
        series_row = series[slot]
        series_row["calls"] += 1
        series_row["total_tokens"] += _as_int(row.get("total_tokens"))
        if row_cost is not None:
            series_row["priced_calls"] += 1
            series_row["estimated_cost_cny"] = round(series_row["estimated_cost_cny"] + row_cost, 6)

    for row in recent_dogfood:
        slot = _bucket_key(_parse_metric_ts(row.get("ts")), bucket)
        series_row = series[slot]
        series_row["dogfood_total"] += 1
        if not bool(row.get("success")):
            series_row["dogfood_failed"] += 1

    by_model_items = []
    for value in by_model.values():
        model_cache_total = (
            value.pop("prompt_cache_hit_tokens")
            + value.pop("prompt_cache_miss_tokens")
        )
        model_hits = sum(
            _as_int(row.get("prompt_cache_hit_tokens"))
            for row in recent_tokens
            if str(row.get("model") or row.get("model_name") or "unknown") == value["model"]
        )
        value["cache_hit_rate"] = (
            round(model_hits / model_cache_total, 4)
            if model_cache_total
            else 0.0
        )
        value["unpriced_calls"] = value["calls"] - value["priced_calls"]
        value["cost_status"] = (
            "available" if value["calls"] and value["unpriced_calls"] == 0
            else ("partial" if value["priced_calls"] else "unavailable")
        )
        if value["cost_status"] != "available":
            value["estimated_cost_cny"] = None
        by_model_items.append(value)

    for value in series.values():
        value["unpriced_calls"] = value["calls"] - value["priced_calls"]
        value["cost_status"] = (
            "available" if value["calls"] and value["unpriced_calls"] == 0
            else ("partial" if value["priced_calls"] else "unavailable")
        )
        if value["cost_status"] != "available":
            value["estimated_cost_cny"] = None

    dogfood_total = len(recent_dogfood)
    dogfood_passed = sum(1 for row in recent_dogfood if bool(row.get("success")))
    dogfood_failed = dogfood_total - dogfood_passed
    dogfood_success_rate = (
        round(dogfood_passed / dogfood_total, 4)
        if dogfood_total
        else 0.0
    )

    alerts: list[dict] = []
    if dogfood_total >= 2 and dogfood_success_rate < 0.8:
        alerts.append({
            "code": "low_dogfood_success_rate",
            "level": "warning",
            "message": "Recent dogfood success rate is below 80%.",
        })
    if unpriced_calls:
        alerts.append({
            "code": "cost_unavailable",
            "level": "info",
            "message": "Provider pricing was not recorded for one or more calls; token cost is unavailable, not zero.",
        })

    return {
        "window": {
            "hours": window_hours,
            "bucket": bucket,
            "since": cutoff.isoformat(timespec="seconds"),
            "until": now.isoformat(timespec="seconds"),
        },
        "tokens": {
            "calls": len(recent_tokens),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "prompt_cache_hit_tokens": cache_hits,
            "prompt_cache_miss_tokens": cache_misses,
            "cache_hit_rate": round(cache_hits / cache_total, 4) if cache_total else 0.0,
            "estimated_cost_cny": estimated_cost,
            "priced_calls": priced_calls,
            "unpriced_calls": unpriced_calls,
            "cost_status": cost_status,
        },
        "dogfood": {
            "total": dogfood_total,
            "passed": dogfood_passed,
            "failed": dogfood_failed,
            "success_rate": dogfood_success_rate,
            "avg_steps": (
                round(sum(_as_int(row.get("steps")) for row in recent_dogfood) / dogfood_total, 2)
                if dogfood_total
                else 0.0
            ),
            "total_tokens": sum(_as_int(row.get("tokens")) for row in recent_dogfood),
            "total_cost_cny": round(
                sum(_as_float(row.get("cost_cny")) for row in recent_dogfood),
                6,
            ),
        },
        "by_model": sorted(by_model_items, key=lambda item: item["model"]),
        "series": [
            {"bucket": key, **value}
            for key, value in sorted(series.items())
        ],
        "alerts": alerts,
        "degraded": any(value is not None for value in issues.values()),
        "issues": issues,
    }


def _parse_metric_ts(value: object) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone().replace(tzinfo=None)
        return parsed
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _bucket_key(ts: datetime | None, bucket: str) -> str:
    if ts is None:
        return "unknown"
    return ts.strftime("%Y-%m-%d") if bucket == "day" else ts.strftime("%Y-%m-%dT%H:00")


def _as_int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _as_float(value: object) -> float:
    if isinstance(value, bool):
        return 0.0
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0
