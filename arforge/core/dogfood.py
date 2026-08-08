"""v1-2.2：dogfood 数据闭环。

每次真实 ``arforge code`` 任务把 outcome（成功/步数/工具/token/成本）追加到
``~/.arforge/dogfood.jsonl``；``arforge dogfood`` 看累计统计（总数/成功率/平均步数/成本）。
为"有数据证明它行"提供真实使用数据，也为学习系统供失败样本。

与 DB 版 learning_outcome 职责不同：这是面向 code 任务的轻量本地遥测（append-only jsonl），
记录失败不抛异常（遥测绝不能影响主流程）。

``record_dogfood_outcome`` 是 AgentRun 生产入口：``arforge/core/agent_run.py`` 的
``AgentRun.execute()`` 在成功/不完整/异常三条路径调用它，把每次生产运行写进 dogfood.jsonl。
"""

from __future__ import annotations

import json
import hashlib
import time
from collections import Counter
from dataclasses import asdict, dataclass, field

from arforge.paths import data_path


def _dogfood_file():
    return data_path("dogfood.jsonl")


@dataclass
class RunOutcome:
    task: str
    success: bool
    steps: int = 0
    tool_calls: int = 0
    failed_tool_calls: int = 0
    llm_calls: int = 0
    tokens: int = 0
    cost_cny: float = 0.0
    modified_files: int = 0
    ts: str = ""
    schema_version: int = 2
    run_id: str = ""
    task_id: str = ""
    suite_id: str = ""
    task_category: str = ""
    provider: str = ""
    model: str = ""
    workspace: str = ""
    duration_seconds: float = 0.0
    stop_reason: str = ""
    reasoning_effort: str = ""
    max_steps: int = 0
    formal: bool = False
    real_model: bool = False
    isolated_workspace: bool = False
    verification_passed: bool = False
    artifact_dir: str = ""
    verification: dict = field(default_factory=dict)


def record_outcome(outcome: RunOutcome) -> bool:
    """追加一条 outcome 到 dogfood.jsonl。失败返回 False（不抛——遥测不影响主流程）。"""
    try:
        f = _dogfood_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        row = asdict(outcome)
        if not row.get("ts"):
            row["ts"] = time.strftime("%Y-%m-%d %H:%M:%S")
        integrity_payload = json.dumps(
            row, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        row["record_hash"] = hashlib.sha256(
            integrity_payload.encode("utf-8")
        ).hexdigest()
        with f.open("a", encoding="utf-8") as h:
            h.write(json.dumps(row, ensure_ascii=False) + "\n")
        return True
    except OSError:
        return False


def record_dogfood_outcome(
    task: str,
    success: bool,
    *,
    error: str = "",
    run_id: str = "",
    task_id: str = "",
    suite_id: str = "",
    task_category: str = "",
    provider: str = "",
    model: str = "",
    workspace: str = "",
    steps: int = 0,
    tool_calls: int = 0,
    failed_tool_calls: int = 0,
    tokens: int = 0,
    cost_cny: float = 0.0,
    modified_files: int = 0,
    duration_seconds: float = 0.0,
    stop_reason: str = "",
    reasoning_effort: str = "",
    max_steps: int = 0,
    formal: bool = False,
    real_model: bool = False,
    isolated_workspace: bool = False,
    verification_passed: bool = False,
    artifact_dir: str = "",
    verification: dict | None = None,
) -> bool:
    """AgentRun 生产入口：记录一次真实 code 任务的 outcome。

    失败返回 False 不抛（遥测纪律：绝不能影响主流程）。
    """
    try:
        outcome = RunOutcome(
            task=task,
            success=success,
            steps=steps,
            tool_calls=tool_calls,
            failed_tool_calls=failed_tool_calls,
            tokens=tokens,
            cost_cny=cost_cny,
            modified_files=modified_files,
            run_id=run_id,
            task_id=task_id,
            suite_id=suite_id,
            task_category=task_category,
            provider=provider,
            model=model,
            workspace=workspace,
            duration_seconds=duration_seconds,
            stop_reason=stop_reason,
            reasoning_effort=reasoning_effort,
            max_steps=max_steps,
            formal=formal,
            real_model=real_model,
            isolated_workspace=isolated_workspace,
            verification_passed=verification_passed,
            artifact_dir=artifact_dir,
            verification=verification or {},
        )
        if not outcome.ts:
            outcome.ts = time.strftime("%Y-%m-%d %H:%M:%S")
        if error and not success:
            outcome.verification = {"error": error}
        return record_outcome(outcome)
    except Exception:
        return False


def load_outcomes() -> list[dict]:
    """读取全部 outcome（容错：坏行跳过）。"""
    f = _dogfood_file()
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


def stats() -> dict:
    rows = load_outcomes()
    total = len(rows)
    passed = sum(1 for r in rows if r.get("success"))
    return {
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "success_rate": round(passed / total, 4) if total else 0.0,
        "avg_steps": round(sum(r.get("steps", 0) for r in rows) / total, 2) if total else 0.0,
        "total_tokens": sum(r.get("tokens", 0) for r in rows),
        "total_cost_cny": round(sum(r.get("cost_cny", 0.0) for r in rows), 6),
    }


def _record_hash_valid(row: dict) -> bool:
    expected = str(row.get("record_hash", ""))
    if not expected:
        return False
    payload = dict(row)
    payload.pop("record_hash", None)
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest() == expected


def formal_dogfood_report(
    *,
    minimum_tasks: int = 50,
    minimum_duration_seconds: float = 15.0,
    minimum_tokens: int = 50_000,
    minimum_steps: int = 5,
    minimum_tool_calls: int = 5,
    minimum_success_rate: float = 0.9,
    required_categories: tuple[str, ...] = (),
) -> dict:
    """Evaluate formal real-model dogfood evidence without counting legacy rows.

    A qualifying task must have an integrity hash, a unique task identity, an
    isolated workspace and explicit post-run verification. Short smoke checks,
    offline adapters and ordinary interactive runs remain useful telemetry but
    cannot satisfy this release gate.
    """
    if minimum_tasks < 1 or minimum_duration_seconds < 0 or minimum_tokens < 0:
        raise ValueError("invalid dogfood evidence thresholds")
    if not 0 <= minimum_success_rate <= 1:
        raise ValueError("minimum_success_rate must be in [0, 1]")

    rows = load_outcomes()
    formal_rows = [
        row
        for row in rows
        if int(row.get("schema_version", 0) or 0) >= 2
        and bool(row.get("formal"))
        and bool(row.get("real_model"))
        and bool(row.get("isolated_workspace"))
        and isinstance(row.get("verification"), dict)
        and bool(row.get("verification"))
        and _record_hash_valid(row)
    ]
    all_qualifying_rows = [
        row
        for row in formal_rows
        if float(row.get("duration_seconds", 0.0) or 0.0)
        >= minimum_duration_seconds
        and int(row.get("tokens", 0) or 0) >= minimum_tokens
        and int(row.get("steps", 0) or 0) >= minimum_steps
        and int(row.get("tool_calls", 0) or 0) >= minimum_tool_calls
        and str(row.get("run_id", "")).strip()
        and str(row.get("task_id", "")).strip()
    ]
    runs: dict[str, list[dict]] = {}
    for row in all_qualifying_rows:
        runs.setdefault(str(row["run_id"]), []).append(row)
    selected_run_id = ""
    qualifying_rows: list[dict] = []
    for candidate_run_id, candidate_rows in runs.items():
        if len(candidate_rows) >= len(qualifying_rows):
            selected_run_id = candidate_run_id
            qualifying_rows = candidate_rows
    task_counts = Counter(str(row["task_id"]) for row in qualifying_rows)
    unique_rows = [
        row for row in qualifying_rows if task_counts[str(row["task_id"])] == 1
    ]
    passed = sum(1 for row in unique_rows if bool(row.get("success")))
    success_rate = passed / len(unique_rows) if unique_rows else 0.0
    categories = {
        str(row.get("task_category", "")).strip()
        for row in unique_rows
        if str(row.get("task_category", "")).strip()
    }
    missing_categories = sorted(set(required_categories) - categories)
    checks = {
        "minimum_tasks": len(unique_rows) >= minimum_tasks,
        "minimum_success_rate": success_rate >= minimum_success_rate,
        "required_categories": not missing_categories,
        "unique_task_ids": len(unique_rows) == len(qualifying_rows),
    }
    evidence_ready = checks["minimum_tasks"] and checks["required_categories"]
    if evidence_ready:
        status = (
            "pass"
            if checks["minimum_success_rate"] and checks["unique_task_ids"]
            else "fail"
        )
    else:
        status = "insufficient_evidence"
    return {
        "schema_version": 1,
        "status": status,
        "total_records": len(rows),
        "formal_verified_records": len(formal_rows),
        "all_qualifying_records": len(all_qualifying_rows),
        "selected_run_id": selected_run_id,
        "formal_runs": len(runs),
        "qualifying_records": len(qualifying_rows),
        "unique_qualifying_tasks": len(unique_rows),
        "duplicate_task_ids": sorted(
            task_id for task_id, count in task_counts.items() if count > 1
        ),
        "passed": passed,
        "failed": len(unique_rows) - passed,
        "success_rate": round(success_rate, 4),
        "categories": sorted(categories),
        "missing_categories": missing_categories,
        "total_duration_seconds": round(
            sum(float(row.get("duration_seconds", 0.0) or 0.0) for row in unique_rows),
            2,
        ),
        "requirements": {
            "minimum_tasks": minimum_tasks,
            "minimum_duration_seconds": minimum_duration_seconds,
            "minimum_tokens": minimum_tokens,
            "minimum_steps": minimum_steps,
            "minimum_tool_calls": minimum_tool_calls,
            "minimum_success_rate": minimum_success_rate,
            "required_categories": list(required_categories),
        },
        "checks": checks,
        "failed_checks": [name for name, passed in checks.items() if not passed],
    }


def longitudinal_dogfood_report(
    *,
    minimum_unique_tasks: int = 100,
    minimum_suites: int = 2,
    minimum_categories: int = 17,
    minimum_first_attempt_success_rate: float = 0.9,
    minimum_latest_success_rate: float = 0.98,
    minimum_duration_seconds: float = 15.0,
    minimum_tokens: int = 50_000,
    minimum_steps: int = 5,
    minimum_tool_calls: int = 5,
) -> dict:
    """Measure diverse formal dogfood across runs without double-counting retries.

    The single-run gate above proves one repeatable batch. This longitudinal
    gate answers the stronger maturity question: have at least 100 different
    verified tasks been attempted across multiple suites, how often did they
    pass on the first qualifying attempt, and did targeted reruns actually
    recover the failures? A retry never increases the unique-task denominator.
    """
    if minimum_unique_tasks < 1 or minimum_suites < 1 or minimum_categories < 1:
        raise ValueError("invalid longitudinal dogfood thresholds")
    for value in (
        minimum_first_attempt_success_rate,
        minimum_latest_success_rate,
    ):
        if not 0 <= value <= 1:
            raise ValueError("success rates must be in [0, 1]")

    rows = load_outcomes()
    qualifying: list[dict] = []
    for sequence, row in enumerate(rows):
        if not (
            int(row.get("schema_version", 0) or 0) >= 2
            and bool(row.get("formal"))
            and bool(row.get("real_model"))
            and bool(row.get("isolated_workspace"))
            and bool(row.get("verification_passed")) == bool(row.get("success"))
            and isinstance(row.get("verification"), dict)
            and bool(row.get("verification"))
            and _record_hash_valid(row)
            and str(row.get("suite_id", "")).strip()
            and str(row.get("task_id", "")).strip()
            and float(row.get("duration_seconds", 0.0) or 0.0)
            >= minimum_duration_seconds
            and int(row.get("tokens", 0) or 0) >= minimum_tokens
            and int(row.get("steps", 0) or 0) >= minimum_steps
            and int(row.get("tool_calls", 0) or 0) >= minimum_tool_calls
        ):
            continue
        materialized = dict(row)
        materialized["_sequence"] = sequence
        qualifying.append(materialized)

    attempts: dict[tuple[str, str], list[dict]] = {}
    for row in qualifying:
        key = (str(row["suite_id"]), str(row["task_id"]))
        attempts.setdefault(key, []).append(row)
    for task_attempts in attempts.values():
        task_attempts.sort(key=lambda row: int(row["_sequence"]))

    first_rows = [task_attempts[0] for task_attempts in attempts.values()]
    latest_rows = [task_attempts[-1] for task_attempts in attempts.values()]
    first_passed = sum(bool(row.get("success")) for row in first_rows)
    latest_passed = sum(bool(row.get("success")) for row in latest_rows)
    unique_tasks = len(attempts)
    first_rate = first_passed / unique_tasks if unique_tasks else 0.0
    latest_rate = latest_passed / unique_tasks if unique_tasks else 0.0
    recovered = sum(
        not bool(task_attempts[0].get("success"))
        and bool(task_attempts[-1].get("success"))
        for task_attempts in attempts.values()
    )
    regressed = sum(
        bool(task_attempts[0].get("success"))
        and not bool(task_attempts[-1].get("success"))
        for task_attempts in attempts.values()
    )
    suites = {str(row.get("suite_id", "")) for row in latest_rows}
    categories = {
        str(row.get("task_category", ""))
        for row in latest_rows
        if str(row.get("task_category", "")).strip()
    }
    checks = {
        "minimum_unique_tasks": unique_tasks >= minimum_unique_tasks,
        "minimum_suites": len(suites) >= minimum_suites,
        "minimum_categories": len(categories) >= minimum_categories,
        "minimum_first_attempt_success_rate": (
            first_rate >= minimum_first_attempt_success_rate
        ),
        "minimum_latest_success_rate": latest_rate >= minimum_latest_success_rate,
        "no_regressions": regressed == 0,
    }
    evidence_ready = all(
        checks[name]
        for name in (
            "minimum_unique_tasks",
            "minimum_suites",
            "minimum_categories",
        )
    )
    status = (
        "pass"
        if evidence_ready and all(checks.values())
        else "fail"
        if evidence_ready
        else "insufficient_evidence"
    )
    return {
        "schema_version": 1,
        "status": status,
        "total_records": len(rows),
        "qualifying_attempts": len(qualifying),
        "unique_tasks": unique_tasks,
        "suites": sorted(suites),
        "categories": sorted(categories),
        "first_attempt_passed": first_passed,
        "first_attempt_failed": unique_tasks - first_passed,
        "first_attempt_success_rate": round(first_rate, 4),
        "latest_passed": latest_passed,
        "latest_failed": unique_tasks - latest_passed,
        "latest_success_rate": round(latest_rate, 4),
        "recovered_tasks": recovered,
        "regressed_tasks": regressed,
        "repeated_attempts": len(qualifying) - unique_tasks,
        "requirements": {
            "minimum_unique_tasks": minimum_unique_tasks,
            "minimum_suites": minimum_suites,
            "minimum_categories": minimum_categories,
            "minimum_first_attempt_success_rate": minimum_first_attempt_success_rate,
            "minimum_latest_success_rate": minimum_latest_success_rate,
            "minimum_duration_seconds": minimum_duration_seconds,
            "minimum_tokens": minimum_tokens,
            "minimum_steps": minimum_steps,
            "minimum_tool_calls": minimum_tool_calls,
        },
        "checks": checks,
        "failed_checks": [name for name, passed in checks.items() if not passed],
    }


def _outcome_fingerprint(row: dict) -> str:
    payload = {
        "task": row.get("task", ""),
        "success": bool(row.get("success")),
        "ts": row.get("ts", ""),
        "steps": row.get("steps", 0),
        "tool_calls": row.get("tool_calls", 0),
    }
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def sync_to_learning(limit: int = 200) -> dict:
    """Import append-only dogfood outcomes into the structured learning store.

    The import is idempotent by storing a deterministic ``dogfood:<hash>`` tag
    on each generated learning outcome.
    """
    from arforge.database import LearningOutcome, get_session
    from arforge.learning_system import Outcome, get_learning_system

    rows = load_outcomes()[-limit:]
    if not rows:
        return {"schema_version": 1, "seen": 0, "imported": 0, "skipped": 0, "failed_candidates": 0}

    fingerprints = {_outcome_fingerprint(row): row for row in rows}
    existing: set[str] = set()
    with get_session() as session:
        for outcome in session.query(LearningOutcome).filter(LearningOutcome.route == "dogfood").all():
            try:
                tags = json.loads(outcome.tags) if outcome.tags else []
            except json.JSONDecodeError:
                tags = []
            for tag in tags:
                if isinstance(tag, str) and tag.startswith("dogfood:"):
                    existing.add(tag.removeprefix("dogfood:"))

    imported = 0
    failed_candidates = 0
    learning = get_learning_system()
    for fingerprint, row in fingerprints.items():
        if fingerprint in existing:
            continue
        success = bool(row.get("success"))
        if not success:
            failed_candidates += 1
        learning.record_outcome(
            Outcome(
                session_id="dogfood",
                user_input=str(row.get("task", ""))[:500],
                intent="code",
                route="dogfood",
                tools_used=["dogfood"],
                success=success,
                error_type="dogfood_failure" if not success else "",
                error_message="" if success else "Dogfood run failed or reached a failure event.",
                tokens_used=int(row.get("tokens", 0) or 0),
                tags=["dogfood", f"dogfood:{fingerprint}"],
                importance=0.6 if success else 0.9,
                injected_context_size=0,
            )
        )
        imported += 1

    return {
        "schema_version": 1,
        "seen": len(rows),
        "imported": imported,
        "skipped": len(rows) - imported,
        "failed_candidates": failed_candidates,
    }


def render_stats(lang: str | None = None) -> str:
    from arforge.i18n import t

    s = stats()
    if s["total"] == 0:
        return t("dogfood.empty", lang)
    return (
        t(
            "dogfood.summary",
            lang,
            total=s["total"],
            passed=s["passed"],
            failed=s["failed"],
            rate=f"{s['success_rate'] * 100:.1f}",
        )
        + "\n"
        + "  "
        + t(
            "dogfood.detail",
            lang,
            steps=s["avg_steps"],
            tokens=s["total_tokens"],
            cost=s["total_cost_cny"],
        )
    )
