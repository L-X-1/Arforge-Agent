"""Persistent token usage and auditable provider-cache evidence."""

from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
import math

from arforge.database import TokenUsage, get_session


_cache_columns_ready = False
_usage_context: ContextVar[dict[str, str]] = ContextVar(
    "arforge_token_usage_context", default={}
)


def run_single_db_init(create_sql: str):  # noqa: ARG001
    """Compatibility shim; tables are created by versioned migrations."""


def register_db_init(name: str, fn):  # noqa: ARG001
    """Compatibility shim for callers from the pre-SQLAlchemy runtime."""
    return {"name": name, "registered": True}


def init_token_db():
    """Compatibility shim; the database engine applies migrations."""


def _ensure_cache_columns(session) -> None:
    """Repair pre-migration token tables idempotently.

    Release databases use Alembic. This guard remains for old developer
    databases whose cache columns were historically added at first write.
    """
    global _cache_columns_ready
    if _cache_columns_ready:
        return
    from sqlalchemy import inspect as sa_inspect, text

    bind = session.get_bind()
    inspector = sa_inspect(bind)
    if inspector.has_table("token_usage"):
        existing = {column["name"] for column in inspector.get_columns("token_usage")}
        for column in ("prompt_cache_hit_tokens", "prompt_cache_miss_tokens"):
            if column not in existing:
                session.execute(
                    text(
                        f"ALTER TABLE token_usage ADD COLUMN {column} "
                        "INTEGER NOT NULL DEFAULT 0"
                    )
                )
        for column in (
            "provider_name",
            "request_kind",
            "stable_prefix_fingerprint",
            "prompt_fingerprint",
            "run_id",
            "task_id",
        ):
            if column not in existing:
                session.execute(
                    text(
                        f"ALTER TABLE token_usage ADD COLUMN {column} "
                        "TEXT NOT NULL DEFAULT ''"
                    )
                )
        session.commit()
    _cache_columns_ready = True


@contextmanager
def token_usage_scope(*, run_id: str = "", task_id: str = ""):
    """Attach formal-run identity to model calls in the current context."""
    current = dict(_usage_context.get())
    if run_id:
        current["run_id"] = str(run_id)
    if task_id:
        current["task_id"] = str(task_id)
    token = _usage_context.set(current)
    try:
        yield
    finally:
        _usage_context.reset(token)


def record_token_usage(
    model_name: str,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    prompt_cache_hit_tokens: int = 0,
    prompt_cache_miss_tokens: int = 0,
    provider_name: str = "",
    request_kind: str = "",
    stable_prefix_fingerprint: str = "",
    prompt_fingerprint: str = "",
    run_id: str = "",
    task_id: str = "",
):
    """Persist usage without allowing telemetry failure to break model calls.

    Usage accounting is an observability side effect.  A database outage or a
    stale local DSN must remain visible in the log, but the provider response
    has already succeeded and must still be returned to the caller.
    """
    if not total_tokens:
        total_tokens = prompt_tokens + completion_tokens
    scope = _usage_context.get()
    run_id = run_id or scope.get("run_id", "")
    task_id = task_id or scope.get("task_id", "")
    try:
        with get_session() as session:
            _ensure_cache_columns(session)
            session.add(
                TokenUsage(
                    created_at=datetime.now().isoformat(timespec="seconds"),
                    model_name=model_name,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    prompt_cache_hit_tokens=prompt_cache_hit_tokens,
                    prompt_cache_miss_tokens=prompt_cache_miss_tokens,
                    provider_name=provider_name,
                    request_kind=request_kind,
                    stable_prefix_fingerprint=stable_prefix_fingerprint,
                    prompt_fingerprint=prompt_fingerprint,
                    run_id=run_id,
                    task_id=task_id,
                )
            )
        return True
    except Exception as exc:  # noqa: BLE001 - telemetry is deliberately fail-open
        from arforge.logger import log_warning

        log_warning(f"token usage telemetry unavailable: {type(exc).__name__}: {exc}")
        return False


def list_token_usage(limit: int = 20):
    from sqlalchemy import desc

    with get_session() as session:
        _ensure_cache_columns(session)
        rows = (
            session.query(TokenUsage)
            .order_by(desc(TokenUsage.id))
            .limit(limit)
            .all()
        )
        return [
            {
                "created_at": row.created_at,
                "model_name": row.model_name,
                "prompt_tokens": row.prompt_tokens,
                "completion_tokens": row.completion_tokens,
                "total_tokens": row.total_tokens,
                "prompt_cache_hit_tokens": row.prompt_cache_hit_tokens,
                "prompt_cache_miss_tokens": row.prompt_cache_miss_tokens,
                "provider_name": row.provider_name,
                "request_kind": row.request_kind,
                "stable_prefix_fingerprint": row.stable_prefix_fingerprint,
                "prompt_fingerprint": row.prompt_fingerprint,
                "run_id": row.run_id,
                "task_id": row.task_id,
            }
            for row in rows
        ]


def cumulative_usage() -> dict:
    """Return lifetime totals; this is descriptive, not an SLO gate."""
    from sqlalchemy import func

    with get_session() as session:
        _ensure_cache_columns(session)
        prompt, completion, total, hit, miss, calls = session.query(
            func.coalesce(func.sum(TokenUsage.prompt_tokens), 0),
            func.coalesce(func.sum(TokenUsage.completion_tokens), 0),
            func.coalesce(func.sum(TokenUsage.total_tokens), 0),
            func.coalesce(func.sum(TokenUsage.prompt_cache_hit_tokens), 0),
            func.coalesce(func.sum(TokenUsage.prompt_cache_miss_tokens), 0),
            func.count(TokenUsage.id),
        ).one()
    cache_total = (hit or 0) + (miss or 0)
    return {
        "prompt_tokens": prompt or 0,
        "completion_tokens": completion or 0,
        "total_tokens": total or 0,
        "prompt_cache_hit_tokens": hit or 0,
        "prompt_cache_miss_tokens": miss or 0,
        "cache_hit_rate": round((hit or 0) / cache_total, 4) if cache_total else 0.0,
        "calls": calls or 0,
    }


def _parse_timestamp(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(
            tzinfo=None
        )
    except (TypeError, ValueError):
        return None


def _wilson_lower_bound(successes: int, total: int, z: float = 1.96) -> float:
    if total <= 0:
        return 0.0
    proportion = successes / total
    denominator = 1.0 + (z * z / total)
    centre = proportion + (z * z / (2.0 * total))
    margin = z * math.sqrt(
        (proportion * (1.0 - proportion) / total)
        + (z * z / (4.0 * total * total))
    )
    return max(0.0, (centre - margin) / denominator)


def cache_slo_report(
    *,
    model_name: str | None = None,
    window_days: int = 30,
    target_hit_rate: float = 0.97,
    minimum_calls: int = 50,
    minimum_observed_tokens: int = 1_000_000,
    minimum_span_hours: float = 168.0,
    minimum_prefix_reuse_rate: float = 0.95,
    run_id: str | None = None,
    request_kinds: tuple[str, ...] = (),
    now: datetime | None = None,
) -> dict:
    """Build a fail-closed DeepSeek cache SLO evidence report.

    Legacy rows without prompt fingerprints remain visible as historical data
    but cannot satisfy the formal gate. The gate requires enough calls, cache
    tokens, elapsed time and repeatable stable-prefix evidence before it can
    declare either pass or fail. The operational default is 97%; callers can
    still request a stricter 99% release or research threshold explicitly.
    """
    if not 0 < target_hit_rate <= 1:
        raise ValueError("target_hit_rate must be in (0, 1]")
    if minimum_calls < 1 or minimum_observed_tokens < 1 or minimum_span_hours < 0:
        raise ValueError("invalid cache SLO evidence thresholds")
    if not 0 <= minimum_prefix_reuse_rate <= 1:
        raise ValueError("minimum_prefix_reuse_rate must be in [0, 1]")

    now = now or datetime.now()
    cutoff = now.timestamp() - max(1, window_days) * 86400
    with get_session() as session:
        _ensure_cache_columns(session)
        query = session.query(TokenUsage)
        if model_name:
            query = query.filter(TokenUsage.model_name == model_name)
        rows = query.order_by(TokenUsage.id.asc()).all()
        materialized = [
            {
                "created_at": row.created_at,
                "model_name": row.model_name,
                "provider_name": row.provider_name,
                "request_kind": row.request_kind,
                "hit": int(row.prompt_cache_hit_tokens or 0),
                "miss": int(row.prompt_cache_miss_tokens or 0),
                "stable_prefix_fingerprint": row.stable_prefix_fingerprint or "",
                "prompt_fingerprint": row.prompt_fingerprint or "",
                "run_id": row.run_id or "",
                "task_id": row.task_id or "",
            }
            for row in rows
        ]

    window_rows = []
    for row in materialized:
        stamp = _parse_timestamp(row["created_at"])
        if stamp is not None and stamp.timestamp() >= cutoff:
            window_rows.append(row)
    observed = [row for row in window_rows if row["hit"] + row["miss"] > 0]
    deepseek_observed = [
        row
        for row in observed
        if row["provider_name"] == "deepseek"
        or (not row["provider_name"] and "deepseek" in row["model_name"].lower())
    ]
    instrumented = [
        row
        for row in deepseek_observed
        if row["stable_prefix_fingerprint"] and row["prompt_fingerprint"]
        and (not run_id or row["run_id"] == run_id)
        and (not request_kinds or row["request_kind"] in request_kinds)
    ]
    fingerprints = Counter(row["stable_prefix_fingerprint"] for row in instrumented)
    reusable_calls = sum(
        1
        for row in instrumented
        if fingerprints[row["stable_prefix_fingerprint"]] >= 2
    )
    hits = sum(row["hit"] for row in instrumented)
    misses = sum(row["miss"] for row in instrumented)
    cache_tokens = hits + misses
    hit_rate = hits / cache_tokens if cache_tokens else 0.0
    prefix_reuse_rate = reusable_calls / len(instrumented) if instrumented else 0.0
    stamps = [
        stamp
        for stamp in (_parse_timestamp(row["created_at"]) for row in instrumented)
        if stamp is not None
    ]
    span_hours = (
        (max(stamps) - min(stamps)).total_seconds() / 3600.0
        if len(stamps) >= 2
        else 0.0
    )

    checks = {
        "minimum_calls": len(instrumented) >= minimum_calls,
        "minimum_observed_tokens": cache_tokens >= minimum_observed_tokens,
        "minimum_span_hours": span_hours >= minimum_span_hours,
        "minimum_prefix_reuse_rate": prefix_reuse_rate >= minimum_prefix_reuse_rate,
        "target_hit_rate": hit_rate >= target_hit_rate,
    }
    evidence_ready = all(
        checks[name]
        for name in (
            "minimum_calls",
            "minimum_observed_tokens",
            "minimum_span_hours",
            "minimum_prefix_reuse_rate",
        )
    )
    if evidence_ready:
        status = "pass" if checks["target_hit_rate"] else "fail"
    else:
        status = "insufficient_evidence"
    return {
        "schema_version": 1,
        "status": status,
        "window_days": max(1, window_days),
        "model_name": model_name or "*",
        "run_id": run_id or "*",
        "request_kinds": list(request_kinds),
        "target_hit_rate": target_hit_rate,
        "cache_hit_rate": round(hit_rate, 6),
        "cache_hit_rate_wilson_lower_95": round(
            _wilson_lower_bound(hits, cache_tokens), 6
        ),
        "instrumented_calls": len(instrumented),
        "legacy_observed_calls": len(deepseek_observed) - len(instrumented),
        "observed_cache_tokens": cache_tokens,
        "prompt_cache_hit_tokens": hits,
        "prompt_cache_miss_tokens": misses,
        "measurement_span_hours": round(span_hours, 2),
        "stable_prefixes": len(fingerprints),
        "prefix_reuse_rate": round(prefix_reuse_rate, 6),
        "formal_runs": len(
            {row["run_id"] for row in instrumented if row["run_id"]}
        ),
        "formal_tasks": len(
            {row["task_id"] for row in instrumented if row["task_id"]}
        ),
        "requirements": {
            "minimum_calls": minimum_calls,
            "minimum_observed_tokens": minimum_observed_tokens,
            "minimum_span_hours": minimum_span_hours,
            "minimum_prefix_reuse_rate": minimum_prefix_reuse_rate,
        },
        "checks": checks,
        "failed_checks": [name for name, passed in checks.items() if not passed],
    }
