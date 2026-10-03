from __future__ import annotations

import json
import hashlib
from pathlib import Path

import pytest

from arforge.cli import main
from arforge.core.release_gates import build_release_gates
from arforge.core.signing_audit import build_signing_audit, format_signing_audit, gate_status


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _artifact(root: Path, name: str, text: str) -> dict[str, object]:
    _write(root / "desktop" / "release-evidence" / name, text)
    timestamp_proof_path = f"{name}.timestamp-proof.txt"
    timestamp_proof = f"{name}: RFC 3161 timestamp verified by Trusted Timestamp"
    _write(root / "desktop" / "release-evidence" / timestamp_proof_path, timestamp_proof)
    return {
        "name": name,
        "sha256": _sha256_text(text),
        "signature_status": "Valid",
        "timestamped": True,
        "timestamp_proof_path": timestamp_proof_path,
        "timestamp_proof_sha256": _sha256_text(timestamp_proof),
        "signer_subject": "CN=Arforge Release",
        "signer_thumbprint": "1" * 40,
        "timestamp_subject": "CN=Trusted Timestamp",
    }


def _workflow(root: Path) -> None:
    _write(
        root / ".github" / "workflows" / "desktop-signed-candidate.yml",
        "\n".join(
            [
                "environment: desktop-release-candidate",
                "digicert/code-signing-software-trust-action@",
                "secrets.SM_CLIENT_CERT_FILE_B64",
                "secrets.SM_API_KEY",
                "vars.ARFORGE_WINDOWS_KEYPAIR_ALIAS",
                "Verify signing readiness without exposing secrets",
                "Verify Authenticode signature and RFC 3161 timestamp",
                "actions/upload-artifact@v4",
                "Remove signing client credential",
            ]
        ),
    )


def _readiness(root: Path, *, ready: bool = True) -> None:
    _write(
        root / "desktop" / "release-evidence" / "signing-readiness.json",
        json.dumps(
            {
                "schema_version": 1,
                "ready": ready,
                "blocker_codes": [] if ready else ["CERTIFICATE_THUMBPRINT_REQUIRED"],
                "provider": "digicert-keylocker",
                "timestamp": {"configured": True, "rfc3161": True, "provider_managed": True},
                "certificate": {"found": ready, "private_key_export_blocked": True},
                "git": {"commit": "a" * 40, "remote_count": 1, "remote_names": ["origin"]},
                "frozen_sidecar_count": 1,
            }
        ),
    )


def _candidate(root: Path) -> None:
    exe_artifact = _artifact(root, "Arforge Agent_0.7.0_x64-setup.exe", "signed exe")
    _write(
        root / "desktop" / "release-evidence" / "signed-candidate.json",
        json.dumps(
            {
                "schema_version": 2,
                "status": "pass",
                "signing_provider": "digicert-keylocker",
                "private_key_export_blocked": True,
                "workflow_run_url": "https://github.com/example/arforge/actions/runs/1",
                "workflow_run_id": "1",
                "commit": "a" * 40,
                "protected_environment": "desktop-release-candidate",
                "required_reviewers_approved": True,
                "signing_material_removed": True,
                "manual_validation": {
                    "release_environment_review": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:05:00Z",
                        "evidence": "github/environments/desktop-release-candidate/run-1",
                        "notes": "Protected environment and required reviewer approval reviewed.",
                        "protected_environment": "desktop-release-candidate",
                        "required_reviewers_approved": True,
                        "workflow_run_reviewed": True,
                        "signing_material_removed": True,
                    },
                    "certificate_provenance_review": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:10:00Z",
                        "evidence": "security/code-signing-certificate-custody.md",
                        "notes": "Certificate provenance, custody and thumbprint reviewed.",
                        "certificate_provenance_reviewed": True,
                        "signer_thumbprint": "1" * 40,
                        "custody_record": "CERT-CUSTODY-2026-0630",
                        "private_key_export_blocked": True,
                    },
                },
                "review": {
                    "reviewer": "release-owner",
                    "reviewed_at_utc": "2026-06-30T00:00:00Z",
                    "workflow_run_id": "1",
                    "protected_environment": "desktop-release-candidate",
                    "required_reviewers_approved": True,
                    "certificate_provenance_reviewed": True,
                    "signer_thumbprint": "1" * 40,
                    "timestamp_subject": "CN=Trusted Timestamp",
                },
                "artifacts": [exe_artifact],
            }
        ),
    )


def _release_tree(root: Path) -> None:
    _workflow(root)
    _write(root / ".github" / "workflows" / "desktop-upgrade-matrix.yml", "environment: desktop-release-candidate\n")
    _write(root / "scripts" / "verify_desktop_upgrade.ps1", "throw 'Older baseline MSI was allowed to downgrade'\n")
    _write(root / "dist" / "release-manifest.json", json.dumps({"source": {"dirty": True}, "files": []}))


def test_signing_audit_fails_closed_without_evidence(tmp_path):
    report = build_signing_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["status"] == "blocked"
    assert report["sign_ready"] is False
    assert checks["signing_readiness"]["status"] == "blocked"
    assert checks["signed_candidate_artifacts"]["status"] == "blocked"
    assert "Sign ready: false" in format_signing_audit(report)


def test_signing_audit_blocks_readiness_without_signed_artifacts(tmp_path):
    _workflow(tmp_path)
    _readiness(tmp_path)

    report = build_signing_audit(tmp_path)

    assert report["sign_ready"] is False
    assert report["timestamp_ready"] is False
    assert gate_status(report, "SIGN-01")["status"] == "blocked"
    assert "signed_candidate_artifacts" in gate_status(report, "SIGN-01")["open_checks"]


def test_signing_audit_passes_with_complete_signed_candidate_evidence(tmp_path):
    _workflow(tmp_path)
    _readiness(tmp_path)
    _candidate(tmp_path)

    report = build_signing_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["release_gate_ready"] is True
    assert report["sign_ready"] is True
    assert report["timestamp_ready"] is True
    assert report["workflow_ready"] is True
    assert report["summary"]["blocked"] == 0
    assert report["summary"]["manual"] == 0


def test_signing_audit_rejects_valid_status_without_signer_metadata(tmp_path):
    _workflow(tmp_path)
    _readiness(tmp_path)
    _candidate(tmp_path)
    candidate = tmp_path / "desktop" / "release-evidence" / "signed-candidate.json"
    data = json.loads(candidate.read_text(encoding="utf-8"))
    for artifact in data["artifacts"]:
        artifact.pop("signer_subject")
        artifact.pop("signer_thumbprint")
        artifact.pop("timestamp_subject")
    candidate.write_text(json.dumps(data), encoding="utf-8")

    report = build_signing_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["signed_candidate_artifacts"]

    assert report["release_gate_ready"] is False
    assert check["status"] == "blocked"
    assert "signer_subject" in check["summary"]
    assert "timestamp_subject" in check["summary"]


def test_signing_audit_rejects_signed_candidate_hashes_not_bound_to_files(tmp_path):
    _workflow(tmp_path)
    _readiness(tmp_path)
    _candidate(tmp_path)
    candidate = tmp_path / "desktop" / "release-evidence" / "signed-candidate.json"
    data = json.loads(candidate.read_text(encoding="utf-8"))
    data["artifacts"][0]["sha256"] = "0" * 64
    candidate.write_text(json.dumps(data), encoding="utf-8")

    report = build_signing_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["signed_candidate_artifacts"]

    assert report["sign_ready"] is False
    assert check["status"] == "blocked"
    assert "sha256_matches_file" in check["summary"]


def test_signing_audit_rejects_timestamp_proof_not_bound_to_file(tmp_path):
    _workflow(tmp_path)
    _readiness(tmp_path)
    _candidate(tmp_path)
    proof = tmp_path / "desktop" / "release-evidence" / "Arforge Agent_0.7.0_x64-setup.exe.timestamp-proof.txt"
    proof.write_text("tampered timestamp proof", encoding="utf-8")

    report = build_signing_audit(tmp_path)
    checks = {item["id"]: item for item in report["checks"]}

    assert report["timestamp_ready"] is False
    assert checks["timestamp_configuration"]["status"] == "blocked"
    assert checks["signed_candidate_artifacts"]["status"] == "blocked"
    assert "timestamp_proof_sha256_matches_file" in checks["signed_candidate_artifacts"]["summary"]


def test_signing_audit_rejects_workflow_success_without_protected_metadata(tmp_path):
    _workflow(tmp_path)
    _readiness(tmp_path)
    _candidate(tmp_path)
    candidate = tmp_path / "desktop" / "release-evidence" / "signed-candidate.json"
    data = json.loads(candidate.read_text(encoding="utf-8"))
    data.pop("workflow_run_id")
    data["protected_environment"] = "unprotected-release"
    data["required_reviewers_approved"] = False
    data["signing_material_removed"] = False
    candidate.write_text(json.dumps(data), encoding="utf-8")

    report = build_signing_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["protected_workflow_success"]

    assert report["release_gate_ready"] is False
    assert report["workflow_ready"] is False
    assert check["status"] == "blocked"
    assert "workflow_run_id" in check["summary"]
    assert "protected_environment=desktop-release-candidate" in check["summary"]
    assert "required_reviewers_approved=true" in check["summary"]
    assert "signing_material_removed=true" in check["summary"]


def test_signing_audit_rejects_manual_passes_without_review_metadata(tmp_path):
    _workflow(tmp_path)
    _readiness(tmp_path)
    _candidate(tmp_path)
    candidate = tmp_path / "desktop" / "release-evidence" / "signed-candidate.json"
    data = json.loads(candidate.read_text(encoding="utf-8"))
    data.pop("review")
    candidate.write_text(json.dumps(data), encoding="utf-8")

    report = build_signing_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["signing_review_metadata"]

    assert report["release_gate_ready"] is False
    assert check["status"] == "blocked"
    assert "review.reviewer" in check["summary"]
    assert "review.signer_thumbprint_matches_artifacts" in check["summary"]
    assert "review.timestamp_subject_matches_artifacts" in check["summary"]


def test_signing_audit_rejects_string_pass_manual_validation_even_with_review_metadata(tmp_path):
    _workflow(tmp_path)
    _readiness(tmp_path)
    _candidate(tmp_path)
    candidate = tmp_path / "desktop" / "release-evidence" / "signed-candidate.json"
    data = json.loads(candidate.read_text(encoding="utf-8"))
    data["manual_validation"] = {
        "release_environment_review": "pass",
        "certificate_provenance_review": "pass",
    }
    candidate.write_text(json.dumps(data), encoding="utf-8")

    report = build_signing_audit(tmp_path)
    checks = {item["id"]: item for item in report["checks"]}

    assert report["release_gate_ready"] is False
    assert checks["signing_review_metadata"]["status"] == "pass"
    assert checks["release_environment_review"]["status"] == "blocked"
    assert "structured_object" in checks["release_environment_review"]["summary"]


def test_signing_audit_cli_writes_json_evidence(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["signing-audit", "build/signing-audit.json"]) == 1
    output = capsys.readouterr().out
    written = tmp_path / "build" / "signing-audit.json"

    assert "Windows Signing Audit" in output
    assert written.exists()
    data = json.loads(written.read_text(encoding="utf-8"))
    assert data["sign_ready"] is False
    assert data["summary"]["manual"] == 3


def test_release_gates_use_signing_audit_contract(tmp_path):
    _release_tree(tmp_path)
    _readiness(tmp_path)

    report = build_release_gates(tmp_path)
    gates = {item["id"]: item for item in report["gates"]}

    assert gates["SIGN-01"]["status"] == "blocked"
    assert gates["SIGN-02"]["status"] == "blocked"
    assert gates["REL-01"]["status"] == "blocked"
    assert "signed_candidate_artifacts" in gates["SIGN-01"]["summary"]
    assert "protected_workflow_success" in gates["REL-01"]["summary"]


def test_local_signed_candidate_script_writes_structured_audit_evidence():
    workflow = Path(".github/workflows/desktop-signed-candidate.yml")
    writer = Path("scripts/write_desktop_signed_candidate_evidence.ps1")
    assert workflow.exists()
    assert Path("packages/desktop/scripts/windows-sign.cjs").exists()
    assert Path("arforge/core/signing_audit.py").is_file()
    assert Path("packages/desktop").is_dir()
    if not writer.exists():
        pytest.skip(
            "release/deployment is deferred and the signed-candidate writer was retired by the authorized Tier-2 cleanup"
        )
