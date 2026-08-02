from __future__ import annotations

from types import SimpleNamespace

import pytest

from arforge.core.staging_validation import require_staging_environment, run_load_probe


def _fault_injection_evidence():
    return {
        "schema_version": 1,
        "injection_layer": "loopback_http_tcp_proxy",
        "started_at_utc": "2026-08-01T00:00:00+00:00",
        "completed_at_utc": "2026-08-01T00:00:01+00:00",
        "scenarios": [
            {
                "scenario": scenario,
                "injection_layer": "loopback_http_tcp_proxy",
                "proxy_requests": 1,
                "request_body_sha256": "a" * 64,
                "fault_detected": True,
                "false_success": False,
                "retry_proxy_requests": 2,
                "automatic_retry_recovered": True,
                "retry_content_valid": True,
                "retry_not_truncated": True,
            }
            for scenario in ("http_429", "http_503", "connection_drop")
        ],
        "recovery": {
            "started_at_utc": "2026-08-01T00:00:01+00:00",
            "completed_at_utc": "2026-08-01T00:00:02+00:00",
            "after_all_faults": True,
            "real_provider_request": True,
            "content_valid": True,
            "not_truncated": True,
        },
        "passed": True,
    }


class _Adapter:
    def generate_with_tools(self, _messages, *, tools, max_tokens):
        assert tools is None
        assert max_tokens == 64
        return SimpleNamespace(content="OK", finish_reason="stop")


def test_staging_environment_fails_closed_without_provenance():
    with pytest.raises(RuntimeError, match="explicit isolated test provenance"):
        require_staging_environment({})


def test_staging_environment_accepts_explicit_nonproduction_scope():
    result = require_staging_environment(
        {
            "ARFORGE_STAGING_CREDENTIAL_SCOPE": "github-environment:staging",
            "ARFORGE_STAGING_ENVIRONMENT_ID": "staging-us-east",
            "ARFORGE_STAGING_WORKSPACE_PROFILE": "isolated-ephemeral",
            "ARFORGE_STAGING_TEST_CREDENTIALS": "1",
            "ARFORGE_STAGING_PRODUCTION_CREDENTIALS_ABSENT": "true",
            "ARFORGE_STAGING_PRODUCTION_DATA_ABSENT": "yes",
        }
    )

    assert result["credential_scope"] == "github-environment:staging"
    assert result["environment_id"] == "staging-us-east"


def test_load_probe_measures_every_real_request_without_waiting():
    clock = {"now": 0.0}

    def monotonic() -> float:
        clock["now"] += 0.001
        return clock["now"]

    result = run_load_probe(
        _Adapter,
        requests=6,
        concurrency=2,
        duration_seconds=0,
        monotonic=monotonic,
        sleep=lambda _seconds: None,
    )

    assert result.requests == 6
    assert result.failures == 0
    assert result.error_rate == 0.0
    assert result.p95_latency_ms > 0


def test_release_load_thresholds_cannot_be_shortened(tmp_path):
    from arforge.core.staging_validation import collect_staging_validation

    with pytest.raises(ValueError, match="requests>=100"):
        collect_staging_validation(
            formal_report=tmp_path / "missing.json",
            output_dir=tmp_path,
            release_candidate_id="rc",
            artifact_set_id="artifacts",
            workflow_run_id="run",
            requests=99,
            duration_minutes=14,
        )


def test_collector_writes_real_run_bound_technical_evidence(tmp_path, monkeypatch):
    import json

    import arforge.core.staging_validation as staging_runtime
    import arforge.eval as eval_module
    import arforge.product.model_config_runtime as model_runtime
    from arforge.core.staging_load_audit import (
        build_staging_load_audit,
        write_staging_load_audit,
    )

    formal = tmp_path / "formal.json"
    formal.write_text(
        json.dumps(
            {
                "suite": "formal",
                "total": 50,
                "passed": 48,
                "success_rate": 0.96,
                "total_tokens": 1234,
                "total_cost_cny": 0.5,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        staging_runtime,
        "run_provider_smoke",
        lambda _factory: {
            "started_at_utc": "2026-08-01T00:00:00+00:00",
            "completed_at_utc": "2026-08-01T00:00:01+00:00",
            "failure_recovery": True,
            "failure_probe": "loopback_http_tcp_faults_then_real_provider_recovery",
            "fault_injection": _fault_injection_evidence(),
        },
    )
    monkeypatch.setattr(
        staging_runtime,
        "run_load_probe",
        lambda *_args, **_kwargs: staging_runtime.ProbeResult(
            started_at_utc="2026-08-01T00:01:00+00:00",
            completed_at_utc="2026-08-01T00:16:01+00:00",
            requests=100,
            failures=0,
            duration_seconds=901,
            p95_latency_ms=250,
        ),
    )
    fake_eval_report = SimpleNamespace(
        success_rate=0.95,
        to_dict=lambda: {"total": 19, "success_rate": 0.95},
    )
    monkeypatch.setattr(eval_module, "builtin_tasks", lambda: [])
    monkeypatch.setattr(eval_module, "run_eval", lambda *_args, **_kwargs: fake_eval_report)
    runtime = SimpleNamespace(
        get_resolved_config=lambda: {
            "resolved": True,
            "provider": "deepseek",
            "model": "staging-model",
        },
        create_active_adapter=lambda: _Adapter(),
    )
    monkeypatch.setattr(model_runtime, "get_model_config", lambda: runtime)
    environment = {
        "ARFORGE_STAGING_CREDENTIAL_SCOPE": "github-environment:staging",
        "ARFORGE_STAGING_ENVIRONMENT_ID": "staging-us-east",
        "ARFORGE_STAGING_WORKSPACE_PROFILE": "isolated-ephemeral",
        "ARFORGE_STAGING_TEST_CREDENTIALS": "1",
        "ARFORGE_STAGING_PRODUCTION_CREDENTIALS_ABSENT": "1",
        "ARFORGE_STAGING_PRODUCTION_DATA_ABSENT": "1",
    }

    result = staging_runtime.collect_staging_validation(
        formal_report=formal,
        output_dir=tmp_path / "build" / "release-evidence",
        release_candidate_id="rc-1",
        artifact_set_id="artifacts-1",
        workflow_run_id="workflow-1",
        environ=environment,
    )

    assert result["technical_ready"] is True
    assert result["provider"]["fault_injection"]["passed"] is True
    audit = build_staging_load_audit(tmp_path)
    by_id = {check["id"]: check for check in audit["checks"]}
    for check_id in (
        "provider_staging_smoke",
        "staging_e2e",
        "load_validation",
        "long_run_dogfood",
        "release_candidate_consistency",
        "failure_recovery",
    ):
        assert by_id[check_id]["status"] == "pass"
    assert audit["release_gate_ready"] is False
    write_staging_load_audit(audit, tmp_path / "build" / "staging-audit.json")
    repeated = build_staging_load_audit(tmp_path)
    repeated_by_id = {check["id"]: check for check in repeated["checks"]}
    assert repeated_by_id["staging_e2e"]["status"] == "pass"
