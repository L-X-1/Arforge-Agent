"""Real provider staging, load, and long-run evidence collection.

This module executes technical checks. It intentionally does not manufacture
the release-owner and credential-review attestations required by STAGE-01.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping


_TRUE_VALUES = {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class ProbeResult:
    started_at_utc: str
    completed_at_utc: str
    requests: int
    failures: int
    duration_seconds: float
    p95_latency_ms: float

    @property
    def error_rate(self) -> float:
        return self.failures / self.requests if self.requests else 1.0


def require_staging_environment(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """Validate explicit fail-closed staging provenance declarations."""
    values = os.environ if environ is None else environ
    required_text = {
        "credential_scope": "ARFORGE_STAGING_CREDENTIAL_SCOPE",
        "environment_id": "ARFORGE_STAGING_ENVIRONMENT_ID",
        "workspace_profile": "ARFORGE_STAGING_WORKSPACE_PROFILE",
    }
    required_true = {
        "test_credentials": "ARFORGE_STAGING_TEST_CREDENTIALS",
        "production_credentials_absent": "ARFORGE_STAGING_PRODUCTION_CREDENTIALS_ABSENT",
        "production_data_absent": "ARFORGE_STAGING_PRODUCTION_DATA_ABSENT",
    }
    resolved: dict[str, str] = {}
    missing: list[str] = []
    for field, variable in required_text.items():
        value = str(values.get(variable, "")).strip()
        if not value:
            missing.append(variable)
        else:
            resolved[field] = value
    for field, variable in required_true.items():
        value = str(values.get(variable, "")).strip().casefold()
        if value not in _TRUE_VALUES:
            missing.append(f"{variable}=1")
        else:
            resolved[field] = "true"
    if missing:
        raise RuntimeError(
            "staging validation requires explicit isolated test provenance: "
            + ", ".join(missing)
        )
    return resolved


def run_load_probe(
    adapter_factory: Callable[[], Any],
    *,
    requests: int,
    concurrency: int,
    duration_seconds: float,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> ProbeResult:
    """Run paced concurrent real-model requests and return measured metrics."""
    if requests <= 0:
        raise ValueError("requests must be positive")
    if concurrency <= 0:
        raise ValueError("concurrency must be positive")
    if duration_seconds < 0:
        raise ValueError("duration_seconds cannot be negative")

    started_at = _utc_now()
    started = monotonic()
    batches = math.ceil(requests / concurrency)
    spacing = duration_seconds / max(1, batches - 1)
    latencies: list[float] = []
    failures = 0

    def request_once() -> float:
        from arforge.core.provider_fault_injection import PROVIDER_PROBE_MAX_TOKENS

        request_started = monotonic()
        adapter = adapter_factory()
        response = adapter.generate_with_tools(
            [
                {"role": "system", "content": "Return the exact requested token only."},
                {"role": "user", "content": "Reply with exactly OK."},
            ],
            tools=None,
            max_tokens=PROVIDER_PROBE_MAX_TOKENS,
        )
        if (
            str(getattr(response, "content", "")).strip().casefold() != "ok"
            or str(getattr(response, "finish_reason", "") or "").casefold() == "length"
        ):
            raise RuntimeError("provider returned an unexpected smoke response")
        return (monotonic() - request_started) * 1000

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        submitted = 0
        for batch_index in range(batches):
            scheduled = started + batch_index * spacing
            delay = scheduled - monotonic()
            if delay > 0:
                sleep(delay)
            batch_size = min(concurrency, requests - submitted)
            futures = [pool.submit(request_once) for _ in range(batch_size)]
            submitted += batch_size
            for future in as_completed(futures):
                try:
                    latencies.append(float(future.result()))
                except Exception:  # noqa: BLE001 - failures are measured evidence
                    failures += 1
                    latencies.append(max(0.0, (monotonic() - scheduled) * 1000))

    duration = monotonic() - started
    ordered = sorted(latencies)
    rank = max(0, math.ceil(0.95 * len(ordered)) - 1)
    return ProbeResult(
        started_at_utc=started_at,
        completed_at_utc=_utc_now(),
        requests=requests,
        failures=failures,
        duration_seconds=duration,
        p95_latency_ms=ordered[rank] if ordered else 0.0,
    )


def run_provider_smoke(adapter_factory: Callable[[], Any]) -> dict[str, Any]:
    """Verify real provider reachability and transport-level fault recovery."""
    started_at = _utc_now()

    def call() -> None:
        from arforge.core.provider_fault_injection import PROVIDER_PROBE_MAX_TOKENS

        adapter = adapter_factory()
        response = adapter.generate_with_tools(
            [
                {"role": "system", "content": "Return the exact requested token only."},
                {"role": "user", "content": "Reply with exactly OK."},
            ],
            tools=None,
            max_tokens=PROVIDER_PROBE_MAX_TOKENS,
        )
        if (
            str(getattr(response, "content", "")).strip().casefold() != "ok"
            or str(getattr(response, "finish_reason", "") or "").casefold() == "length"
        ):
            raise RuntimeError("provider returned an unexpected smoke response")

    call()

    from arforge.core.provider_fault_injection import (
        run_provider_transport_fault_probe,
    )
    from arforge.models.deepseek_adapter import DeepSeekAdapter
    from arforge.models.resilience import RetryPolicy

    configured = adapter_factory()
    delegate = getattr(configured, "delegate", configured)
    if not isinstance(delegate, DeepSeekAdapter):
        raise RuntimeError(
            "transport fault injection currently requires an OpenAI-compatible DeepSeek adapter"
        )

    def fault_adapter_factory(proxy_base_url: str, max_retries: int):
        probe = DeepSeekAdapter(
            api_key=delegate.api_key,
            base_url=proxy_base_url,
            model=delegate.model_name,
        )
        # One SDK request must equal one injected proxy event.  Production
        # retries remain exercised separately by the resilience contract.
        probe._retry = RetryPolicy(
            max_retries=max_retries,
            base_delay=0,
            jitter=False,
        )
        return probe

    fault_injection = run_provider_transport_fault_probe(
        fault_adapter_factory,
        upstream_base_url=delegate.base_url,
    )
    return {
        "started_at_utc": started_at,
        "completed_at_utc": _utc_now(),
        "failure_recovery": bool(fault_injection["passed"]),
        "failure_probe": "loopback_http_tcp_faults_then_real_provider_recovery",
        "fault_injection": fault_injection,
    }


def collect_staging_validation(
    *,
    formal_report: str | Path,
    output_dir: str | Path,
    release_candidate_id: str,
    artifact_set_id: str,
    workflow_run_id: str,
    requests: int = 100,
    concurrency: int = 4,
    duration_minutes: float = 15.0,
    token_budget: int = 300_000,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Execute technical staging checks and retain audit-consumable evidence."""
    if requests < 100 or concurrency < 2 or duration_minutes < 15:
        raise ValueError(
            "release staging requires requests>=100, concurrency>=2, duration_minutes>=15"
        )
    if token_budget <= 0:
        raise ValueError("token_budget must be positive")
    provenance = require_staging_environment(environ)
    formal_path = Path(formal_report).resolve()
    report = json.loads(formal_path.read_text(encoding="utf-8"))
    if int(report.get("total", 0) or 0) < 50:
        raise RuntimeError("long-run dogfood requires a complete report with at least 50 tasks")

    from arforge.eval import builtin_tasks, run_eval
    from arforge.product.model_config_runtime import get_model_config

    runtime = get_model_config()
    resolved = runtime.get_resolved_config()
    if not resolved.get("resolved"):
        raise RuntimeError(str(resolved.get("error") or "model configuration unresolved"))
    adapter_factory = runtime.create_active_adapter
    common = {
        "schema_version": 1,
        "release_candidate_id": release_candidate_id,
        "artifact_set_id": artifact_set_id,
        "signed_candidate_workflow_run_id": workflow_run_id,
    }

    provider_probe = run_provider_smoke(adapter_factory)
    staging_started = _utc_now()
    staging_tasks = builtin_tasks()
    for task in staging_tasks:
        task.token_budget = token_budget
    staging_report = run_eval(
        staging_tasks,
        suite="staging-core",
        judge_adapter=adapter_factory(),
        failure_artifacts_dir=Path(output_dir) / "staging-e2e-failures",
    )
    staging_completed = _utc_now()
    load_probe = run_load_probe(
        adapter_factory,
        requests=requests,
        concurrency=concurrency,
        duration_seconds=duration_minutes * 60,
    )

    output = Path(output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    provider = {
        **common,
        "status": "pass" if provider_probe["failure_recovery"] else "blocked",
        "run_id": f"provider-{uuid.uuid4().hex[:12]}",
        **provider_probe,
        "provider": str(resolved.get("provider") or ""),
        "model": str(resolved.get("model") or ""),
        "provider_real": True,
        "test_credentials": True,
        "credential_scope": provenance["credential_scope"],
        "production_credentials": False,
    }
    staging = {
        **common,
        "status": "pass" if staging_report.success_rate >= 0.8 else "blocked",
        "run_id": f"staging-{uuid.uuid4().hex[:12]}",
        "started_at_utc": staging_started,
        "completed_at_utc": staging_completed,
        "environment": "staging",
        "environment_id": provenance["environment_id"],
        "isolated": True,
        "workspace_profile": provenance["workspace_profile"],
        "production_data": False,
        "error_boundary_verified": provider_probe["failure_recovery"],
        "eval": staging_report.to_dict(),
        "token_budget": token_budget,
    }
    measured_minutes = load_probe.duration_seconds / 60
    load = {
        **common,
        "status": "pass"
        if load_probe.error_rate <= 0.02
        and 0 < load_probe.p95_latency_ms <= 10_000
        and measured_minutes >= 15
        else "blocked",
        "run_id": f"load-{uuid.uuid4().hex[:12]}",
        "started_at_utc": load_probe.started_at_utc,
        "completed_at_utc": load_probe.completed_at_utc,
        "environment": "staging",
        "isolated": True,
        "concurrency": concurrency,
        "requests": load_probe.requests,
        "failures": load_probe.failures,
        "duration_minutes": measured_minutes,
        "error_rate": load_probe.error_rate,
        "p95_latency_ms": load_probe.p95_latency_ms,
        "production_credentials": False,
    }
    dogfood = {
        **common,
        "status": "pass" if float(report.get("success_rate", 0.0) or 0.0) >= 0.85 else "blocked",
        "run_id": f"dogfood-{uuid.uuid4().hex[:12]}",
        "started_at_utc": provider_probe["started_at_utc"],
        "completed_at_utc": _utc_now(),
        "total": int(report.get("total", 0) or 0),
        "success_rate": float(report.get("success_rate", 0.0) or 0.0),
        "scope": str(report.get("suite") or "formal"),
        "dataset_hash": _sha256(formal_path),
        "total_tokens": int(report.get("total_tokens", 0) or 0),
        "total_cost_cny": float(report.get("total_cost_cny", 0.0) or 0.0),
        "formal_report": formal_path.name,
    }
    paths = {}
    for name, payload in (
        ("provider", provider),
        ("staging", staging),
        ("load", load),
        ("dogfood", dogfood),
    ):
        filename = {
            "provider": "provider-staging-smoke.json",
            "staging": "staging-e2e.json",
            "load": "provider-load.json",
            "dogfood": "dogfood-long-run.json",
        }[name]
        paths[name] = str(_write_json(output / filename, payload))
    technical_ready = all(
        payload["status"] == "pass" for payload in (provider, staging, load, dogfood)
    )
    return {
        "technical_ready": technical_ready,
        "paths": paths,
        "provider": provider,
        "staging": staging,
        "load": load,
        "dogfood": dogfood,
    }


def _write_json(path: Path, payload: dict[str, Any]) -> Path:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
