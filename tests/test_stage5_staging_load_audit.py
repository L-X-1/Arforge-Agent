from __future__ import annotations

import json
import hashlib
import importlib.util
from pathlib import Path

from arforge.cli import main
from arforge.core.release_gates import build_release_gates
from arforge.core.staging_load_audit import build_staging_load_audit, format_staging_load_audit


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _fault_injection_evidence() -> dict:
    return {
        "schema_version": 1,
        "injection_layer": "loopback_http_tcp_proxy",
        "started_at_utc": "2026-06-30T00:01:00Z",
        "completed_at_utc": "2026-06-30T00:02:00Z",
        "scenarios": [
            {
                "scenario": scenario,
                "injection_layer": "loopback_http_tcp_proxy",
                "proxy_requests": 1,
                "request_body_sha256": hashlib.sha256(scenario.encode()).hexdigest(),
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
            "started_at_utc": "2026-06-30T00:02:00Z",
            "completed_at_utc": "2026-06-30T00:03:00Z",
            "after_all_faults": True,
            "real_provider_request": True,
            "content_valid": True,
            "not_truncated": True,
        },
        "passed": True,
    }


def _release_workflows(root: Path) -> None:
    _write(
        root / ".github" / "workflows" / "desktop-signed-candidate.yml",
        "\n".join(
            [
                "environment: desktop-release-candidate",
                "secrets.ARFORGE_WINDOWS_CERTIFICATE_BASE64",
                "secrets.ARFORGE_WINDOWS_CERTIFICATE_PASSWORD",
                "secrets.ARFORGE_WINDOWS_TIMESTAMP_URL",
                "Verify signing readiness without exposing secrets",
                "actions/upload-artifact@v4",
            ]
        ),
    )
    _write(root / ".github" / "workflows" / "desktop-upgrade-matrix.yml", "environment: desktop-release-candidate\n")
    _write(root / "scripts" / "verify_desktop_upgrade.ps1", "throw 'Older baseline MSI was allowed to downgrade'\n")


def _load_staging_writer():
    script = Path(__file__).resolve().parents[1] / "scripts" / "write_staging_load_evidence.py"
    spec = importlib.util.spec_from_file_location("write_staging_load_evidence", script)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _complete_stage_evidence(root: Path) -> None:
    common = {
        "release_candidate_id": "arforge-0.7.0-rc1",
        "artifact_set_id": "artifact-set-20260630",
        "signed_candidate_workflow_run_id": "9001",
    }
    release_owner_proof = "manual/stage-release-owner-review-20260630.md"
    release_owner_proof_text = "release owner reviewed staging load dogfood and failure recovery"
    test_credentials_proof = "manual/stage-test-credentials-review-20260630.md"
    test_credentials_proof_text = "test credentials were scoped and production credentials were absent"
    _write(root / "build" / "release-evidence" / release_owner_proof, release_owner_proof_text)
    _write(root / "build" / "release-evidence" / test_credentials_proof, test_credentials_proof_text)
    staging_text = json.dumps(
        {
            "schema_version": 1,
            "status": "pass",
            **common,
            "run_id": "staging-e2e-20260630",
            "started_at_utc": "2026-06-30T00:10:00Z",
            "completed_at_utc": "2026-06-30T00:20:00Z",
            "environment": "staging",
            "isolated": True,
            "workspace_profile": "staging-disposable-profile",
            "production_data": False,
            "error_boundary_verified": True,
        }
    )
    load_text = json.dumps(
        {
            "schema_version": 1,
            "status": "pass",
            **common,
            "run_id": "provider-load-20260630",
            "started_at_utc": "2026-06-30T00:30:00Z",
            "completed_at_utc": "2026-06-30T01:00:00Z",
            "environment": "staging",
            "isolated": True,
            "concurrency": 4,
            "requests": 500,
            "duration_minutes": 30,
            "error_rate": 0.01,
            "p95_latency_ms": 3200,
            "production_credentials": False,
        }
    )
    dogfood_text = json.dumps(
        {
            "schema_version": 1,
            "status": "pass",
            **common,
            "run_id": "dogfood-20260630",
            "started_at_utc": "2026-06-30T01:05:00Z",
            "completed_at_utc": "2026-06-30T03:05:00Z",
            "total": 64,
            "success_rate": 0.91,
            "scope": "release-candidate-coding-tasks",
            "dataset_hash": "dogfood-set-20260630",
        }
    )
    _write(
        root / "build" / "release-evidence" / "provider-staging-smoke.json",
        json.dumps(
            {
                "schema_version": 1,
                "status": "pass",
                **common,
                "run_id": "provider-smoke-20260630",
                "started_at_utc": "2026-06-30T00:00:00Z",
                "completed_at_utc": "2026-06-30T00:05:00Z",
                "provider": "deepseek",
                "model": "deepseek-v4-flash",
                "provider_real": True,
                "test_credentials": True,
                "credential_scope": "staging-test-only",
                "production_credentials": False,
                "failure_recovery": True,
                "fault_injection": _fault_injection_evidence(),
                "review": {
                    "reviewer": "release-owner",
                    "reviewed_at_utc": "2026-06-30T04:00:00Z",
                    "release_candidate_id": common["release_candidate_id"],
                    "artifact_set_id": common["artifact_set_id"],
                    "signed_candidate_workflow_run_id": common["signed_candidate_workflow_run_id"],
                    "provider_run_id": "provider-smoke-20260630",
                    "staging_run_id": "staging-e2e-20260630",
                    "load_run_id": "provider-load-20260630",
                    "dogfood_run_id": "dogfood-20260630",
                    "dogfood_dataset_hash": "dogfood-set-20260630",
                    "evidence_paths": {
                        "provider": "build/release-evidence/provider-staging-smoke.json",
                        "staging": "build/release-evidence/staging-e2e.json",
                        "load": "build/release-evidence/provider-load.json",
                        "dogfood": "build/release-evidence/dogfood-long-run.json",
                    },
                    "evidence_sha256": {
                        "staging": _sha256_text(staging_text),
                        "load": _sha256_text(load_text),
                        "dogfood": _sha256_text(dogfood_text),
                    },
                    "test_credentials_scoped": True,
                    "production_credentials_absent": True,
                    "load_thresholds_reviewed": True,
                    "failure_recovery_reviewed": True,
                },
                "manual_validation": {
                    "release_owner_review": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T04:05:00Z",
                        "evidence": "build/release-evidence/provider-staging-smoke.json",
                        "evidence_path": release_owner_proof,
                        "evidence_sha256": _sha256_text(release_owner_proof_text),
                        "notes": "Release candidate, artifact set, run IDs, load thresholds and failure recovery reviewed.",
                        "release_candidate_id": common["release_candidate_id"],
                        "artifact_set_id": common["artifact_set_id"],
                        "signed_candidate_workflow_run_id": common["signed_candidate_workflow_run_id"],
                        "provider_run_id": "provider-smoke-20260630",
                        "staging_run_id": "staging-e2e-20260630",
                        "load_run_id": "provider-load-20260630",
                        "dogfood_run_id": "dogfood-20260630",
                        "failure_recovery_reviewed": True,
                        "load_thresholds_reviewed": True,
                    },
                    "test_credentials_review": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T04:10:00Z",
                        "evidence": "build/release-evidence/provider-staging-smoke.json",
                        "evidence_path": test_credentials_proof,
                        "evidence_sha256": _sha256_text(test_credentials_proof_text),
                        "notes": "Provider staging used independent scoped test credentials.",
                        "test_credentials_scoped": True,
                        "production_credentials_absent": True,
                        "credential_scope": "staging-test-only",
                        "provider": "deepseek",
                        "model": "deepseek-v4-flash",
                    },
                },
            }
        ),
    )
    _write(root / "build" / "release-evidence" / "staging-e2e.json", staging_text)
    _write(root / "build" / "release-evidence" / "provider-load.json", load_text)
    _write(root / "build" / "release-evidence" / "dogfood-long-run.json", dogfood_text)


def test_staging_load_audit_fails_closed_without_evidence(tmp_path):
    report = build_staging_load_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["status"] == "blocked"
    assert report["release_gate_ready"] is False
    assert checks["provider_staging_smoke"]["status"] == "blocked"
    assert checks["load_validation"]["status"] == "blocked"
    assert checks["long_run_dogfood"]["status"] == "blocked"
    assert checks["release_owner_review"]["status"] == "manual"
    assert "Release gate ready: false" in format_staging_load_audit(report)


def test_staging_load_audit_passes_with_complete_release_evidence(tmp_path):
    _complete_stage_evidence(tmp_path)

    report = build_staging_load_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["release_gate_ready"] is True
    assert report["summary"]["blocked"] == 0
    assert report["summary"]["manual"] == 0
    assert sorted(report["evidence_files"]) == [
        "build/release-evidence/dogfood-long-run.json",
        "build/release-evidence/provider-load.json",
        "build/release-evidence/provider-staging-smoke.json",
        "build/release-evidence/staging-e2e.json",
    ]


def test_staging_load_audit_blocks_weak_load_evidence(tmp_path):
    _complete_stage_evidence(tmp_path)
    _write(
        tmp_path / "build" / "release-evidence" / "provider-load.json",
        json.dumps(
            {
                "schema_version": 1,
                "status": "pass",
                "requests": 20,
                "duration_minutes": 3,
                "error_rate": 0.15,
                "p95_latency_ms": 15000,
            }
        ),
    )

    report = build_staging_load_audit(tmp_path)
    load = {check["id"]: check for check in report["checks"]}["load_validation"]

    assert report["release_gate_ready"] is False
    assert load["status"] == "blocked"
    assert "requests>=100" in load["summary"]


def test_staging_load_audit_rejects_threshold_only_load_without_traceability(tmp_path):
    _complete_stage_evidence(tmp_path)
    _write(
        tmp_path / "build" / "release-evidence" / "provider-load.json",
        json.dumps(
            {
                "schema_version": 1,
                "status": "pass",
                "requests": 500,
                "duration_minutes": 30,
                "error_rate": 0.01,
                "p95_latency_ms": 3200,
            }
        ),
    )

    report = build_staging_load_audit(tmp_path)
    load = {check["id"]: check for check in report["checks"]}["load_validation"]

    assert report["release_gate_ready"] is False
    assert load["status"] == "blocked"
    assert "run_id" in load["summary"]
    assert "concurrency>=2" in load["summary"]
    assert "release_candidate_id" in load["summary"]


def test_staging_load_audit_rejects_mixed_release_candidate_evidence(tmp_path):
    _complete_stage_evidence(tmp_path)
    dogfood = tmp_path / "build" / "release-evidence" / "dogfood-long-run.json"
    data = json.loads(dogfood.read_text(encoding="utf-8"))
    data["release_candidate_id"] = "arforge-0.7.0-rc2"
    data["artifact_set_id"] = "artifact-set-other"
    dogfood.write_text(json.dumps(data), encoding="utf-8")

    report = build_staging_load_audit(tmp_path)
    consistency = {check["id"]: check for check in report["checks"]}["release_candidate_consistency"]

    assert report["release_gate_ready"] is False
    assert consistency["status"] == "blocked"
    assert "same release_candidate_id" in consistency["summary"]
    assert "same artifact_set_id" in consistency["summary"]


def test_staging_load_audit_rejects_manual_passes_without_review_metadata(tmp_path):
    _complete_stage_evidence(tmp_path)
    provider = tmp_path / "build" / "release-evidence" / "provider-staging-smoke.json"
    data = json.loads(provider.read_text(encoding="utf-8"))
    data.pop("review")
    provider.write_text(json.dumps(data), encoding="utf-8")

    report = build_staging_load_audit(tmp_path)
    review = {check["id"]: check for check in report["checks"]}["staging_review_metadata"]

    assert report["release_gate_ready"] is False
    assert review["status"] == "manual"
    assert "Structured staging/load review evidence is required" in review["summary"]


def test_staging_load_audit_rejects_string_pass_manual_validation_even_with_review_metadata(tmp_path):
    _complete_stage_evidence(tmp_path)
    provider = tmp_path / "build" / "release-evidence" / "provider-staging-smoke.json"
    data = json.loads(provider.read_text(encoding="utf-8"))
    data["manual_validation"] = {
        "release_owner_review": "pass",
        "test_credentials_review": "pass",
    }
    provider.write_text(json.dumps(data), encoding="utf-8")

    report = build_staging_load_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["release_gate_ready"] is False
    assert checks["staging_review_metadata"]["status"] == "pass"
    assert checks["release_owner_review"]["status"] == "blocked"
    assert "structured_object" in checks["release_owner_review"]["summary"]


def test_staging_load_audit_rejects_review_metadata_without_evidence_paths(tmp_path):
    _complete_stage_evidence(tmp_path)
    provider = tmp_path / "build" / "release-evidence" / "provider-staging-smoke.json"
    data = json.loads(provider.read_text(encoding="utf-8"))
    data["review"].pop("evidence_paths")
    provider.write_text(json.dumps(data), encoding="utf-8")

    report = build_staging_load_audit(tmp_path)
    review = {check["id"]: check for check in report["checks"]}["staging_review_metadata"]

    assert report["release_gate_ready"] is False
    assert review["status"] == "blocked"
    assert "evidence_paths.provider" in review["summary"]


def test_staging_load_audit_rejects_review_metadata_hash_not_bound_to_file(tmp_path):
    _complete_stage_evidence(tmp_path)
    load = tmp_path / "build" / "release-evidence" / "provider-load.json"
    data = json.loads(load.read_text(encoding="utf-8"))
    data["requests"] = 501
    load.write_text(json.dumps(data), encoding="utf-8")

    report = build_staging_load_audit(tmp_path)
    review = {check["id"]: check for check in report["checks"]}["staging_review_metadata"]

    assert report["release_gate_ready"] is False
    assert review["status"] == "blocked"
    assert "evidence_sha256.load_matches_file" in review["summary"]


def test_staging_load_audit_rejects_manual_review_hash_not_bound_to_file(tmp_path):
    _complete_stage_evidence(tmp_path)
    proof = tmp_path / "build" / "release-evidence" / "manual" / "stage-test-credentials-review-20260630.md"
    proof.write_text("tampered test credentials proof", encoding="utf-8")

    report = build_staging_load_audit(tmp_path)
    review = {check["id"]: check for check in report["checks"]}["test_credentials_review"]

    assert report["release_gate_ready"] is False
    assert review["status"] == "blocked"
    assert "evidence_sha256_matches_file" in review["summary"]


def test_staging_audit_cli_writes_json_evidence(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["staging-audit", "build/staging-audit.json"]) == 1
    output = capsys.readouterr().out
    written = tmp_path / "build" / "staging-audit.json"

    assert "Provider Staging Load Audit" in output
    assert written.exists()
    data = json.loads(written.read_text(encoding="utf-8"))
    assert data["release_gate_ready"] is False
    assert data["summary"]["manual"] == 3


def test_release_gate_uses_staging_load_audit_contract(tmp_path):
    _release_workflows(tmp_path)
    _write(
        tmp_path / "build" / "release-evidence-2026-06-29-signing" / "signing-readiness.json",
        json.dumps({"ready": False, "blocker_codes": ["CERTIFICATE_THUMBPRINT_REQUIRED"], "timestamp": {"https": False}}),
    )
    _write(tmp_path / "dist" / "release-manifest.json", json.dumps({"source": {"dirty": False}, "files": []}))

    report = build_release_gates(tmp_path)
    gate = {item["id"]: item for item in report["gates"]}["STAGE-01"]

    assert gate["status"] == "blocked"
    assert "Staging/load audit is not release-ready" in gate["summary"]
    assert "provider_staging_smoke" in gate["summary"]


def test_staging_load_evidence_writer_rejects_weak_load_thresholds(tmp_path, capsys):
    writer = _load_staging_writer()
    release_owner = tmp_path / "release-owner.md"
    credentials = tmp_path / "credentials.md"
    release_owner.write_text("release owner reviewed", encoding="utf-8")
    credentials.write_text("test credentials reviewed", encoding="utf-8")

    result = writer.main(
        [
            "--root",
            str(tmp_path),
            "--reviewer",
            "release-owner",
            "--release-candidate-id",
            "arforge-0.7.0-rc1",
            "--artifact-set-id",
            "artifact-set-20260701",
            "--signed-candidate-workflow-run-id",
            "9001",
            "--provider-run-id",
            "provider-smoke-20260701",
            "--staging-run-id",
            "staging-e2e-20260701",
            "--load-run-id",
            "provider-load-20260701",
            "--dogfood-run-id",
            "dogfood-20260701",
            "--provider",
            "deepseek",
            "--model",
            "deepseek-v4-flash",
            "--credential-scope",
            "staging-test-only",
            "--workspace-profile",
            "staging-disposable-profile",
            "--load-concurrency",
            "1",
            "--load-requests",
            "20",
            "--load-duration-minutes",
            "3",
            "--load-error-rate",
            "0.15",
            "--load-p95-latency-ms",
            "15000",
            "--dogfood-total",
            "64",
            "--dogfood-success-rate",
            "0.91",
            "--dogfood-scope",
            "release-candidate-coding-tasks",
            "--dogfood-dataset-hash",
            "dogfood-set-20260701",
            "--release-owner-proof",
            str(release_owner),
            "--test-credentials-proof",
            str(credentials),
            "--provider-real",
            "--test-credentials-scoped",
            "--production-credentials-absent",
            "--staging-isolated",
            "--production-data-absent",
            "--failure-recovery-reviewed",
            "--load-thresholds-reviewed",
        ]
    )

    assert result == 2
    err = capsys.readouterr().err
    assert "--load-concurrency must be >= 2" in err
    assert "--load-error-rate must be <= 0.02" in err


def test_staging_load_evidence_writer_outputs_audit_consumable_package(tmp_path):
    writer = _load_staging_writer()
    release_owner = tmp_path / "release-owner.md"
    credentials = tmp_path / "credentials.md"
    release_owner.write_text("release owner reviewed staging load and failure recovery", encoding="utf-8")
    credentials.write_text("test credentials scoped and production credentials absent", encoding="utf-8")
    fault_evidence = tmp_path / "fault-injection.json"
    fault_evidence.write_text(
        json.dumps(_fault_injection_evidence()),
        encoding="utf-8",
    )

    result = writer.main(
        [
            "--root",
            str(tmp_path),
            "--reviewer",
            "release-owner",
            "--release-candidate-id",
            "arforge-0.7.0-rc1",
            "--artifact-set-id",
            "artifact-set-20260701",
            "--signed-candidate-workflow-run-id",
            "9001",
            "--provider-run-id",
            "provider-smoke-20260701",
            "--staging-run-id",
            "staging-e2e-20260701",
            "--load-run-id",
            "provider-load-20260701",
            "--dogfood-run-id",
            "dogfood-20260701",
            "--provider",
            "deepseek",
            "--model",
            "deepseek-v4-flash",
            "--credential-scope",
            "staging-test-only",
            "--workspace-profile",
            "staging-disposable-profile",
            "--load-concurrency",
            "4",
            "--load-requests",
            "500",
            "--load-duration-minutes",
            "30",
            "--load-error-rate",
            "0.01",
            "--load-p95-latency-ms",
            "3200",
            "--dogfood-total",
            "64",
            "--dogfood-success-rate",
            "0.91",
            "--dogfood-scope",
            "release-candidate-coding-tasks",
            "--dogfood-dataset-hash",
            "dogfood-set-20260701",
            "--release-owner-proof",
            str(release_owner),
            "--test-credentials-proof",
            str(credentials),
            "--fault-injection-evidence",
            str(fault_evidence),
            "--provider-real",
            "--test-credentials-scoped",
            "--production-credentials-absent",
            "--staging-isolated",
            "--production-data-absent",
            "--failure-recovery-reviewed",
            "--load-thresholds-reviewed",
        ]
    )

    assert result == 0
    report = build_staging_load_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["release_gate_ready"] is True
    assert sorted(report["evidence_files"]) == [
        "desktop/release-evidence/dogfood-long-run.json",
        "desktop/release-evidence/provider-load.json",
        "desktop/release-evidence/provider-staging-smoke.json",
        "desktop/release-evidence/staging-e2e.json",
    ]
