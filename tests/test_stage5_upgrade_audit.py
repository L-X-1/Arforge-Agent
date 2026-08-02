from __future__ import annotations

import json
import hashlib
from pathlib import Path

from arforge.cli import main
from arforge.core.release_gates import build_release_gates
from arforge.core.upgrade_audit import build_upgrade_audit, format_upgrade_audit


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _upgrade_contract(root: Path) -> None:
    _write(
        root / ".github" / "workflows" / "desktop-upgrade-matrix.yml",
        "\n".join(
            [
                "environment: desktop-release-candidate",
                "baseline_run_id",
                "candidate_run_id",
                "baseline_msi_sha256",
                "candidate_msi_sha256",
                "actions/download-artifact@v4",
                "scripts/verify_desktop_upgrade.ps1",
                "RequireValidSignature",
                "actions/upload-artifact@v4",
            ]
        ),
    )
    _write(
        root / "scripts" / "verify_desktop_upgrade.ps1",
        "\n".join(
            [
                "Get-AuthenticodeSignature",
                "TimeStamperCertificate",
                "Candidate MSI version",
                "Baseline MSI install failed",
                "Candidate MSI upgrade failed",
                "Older baseline MSI was allowed to downgrade",
                "Profile marker changed during candidate upgrade",
                "preserved_after_uninstall",
                "desktop-upgrade-evidence.json",
            ]
        ),
    )


def _sha(prefix: str) -> str:
    return prefix * 64


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _artifact(root: Path, name: str, text: str) -> str:
    _write(root / "desktop" / "release-evidence" / name, text)
    return _sha256_text(text)


def _complete_evidence(root: Path) -> dict:
    baseline_sha = _artifact(root, "Arforge Agent_0.7.0_x64_en-US.msi", "baseline msi")
    candidate_sha = _artifact(root, "Arforge Agent_0.7.1_x64_en-US.msi", "candidate msi")
    marker_path = "profiles/upgrade-profile-marker.txt"
    marker_sha = _artifact(root, marker_path, "preserved upgrade profile")
    return {
        "schema_version": 1,
        "status": "pass",
        "signatures_required": True,
        "baseline": {
            "version": "0.7.0",
            "workflow_run_id": "1001",
            "artifact_name": "Arforge Agent_0.7.0_x64_en-US.msi",
            "sha256": baseline_sha,
            "sha256_reviewed": True,
            "install_exit_code": 0,
        },
        "candidate": {
            "version": "0.7.1",
            "workflow_run_id": "1002",
            "artifact_name": "Arforge Agent_0.7.1_x64_en-US.msi",
            "sha256": candidate_sha,
            "sha256_reviewed": True,
            "install_exit_code": 0,
            "installed_app_sha256": _sha("c"),
            "uninstall_exit_code": 0,
        },
        "downgrade": {"rejected": True, "exit_code": 1603, "candidate_app_preserved": True},
        "profile": {
            "preserved_through_upgrade": True,
            "marker_path": marker_path,
            "marker_sha256": marker_sha,
            "preserved_after_uninstall": True,
        },
        "signatures": [
            {"path": "baseline.msi", "status": "Valid", "timestamp_subject": "CN=Timestamp"},
            {"path": "candidate.msi", "status": "Valid", "timestamp_subject": "CN=Timestamp"},
            {"path": "arforge-agent-desktop.exe", "status": "Valid", "timestamp_subject": "CN=Timestamp"},
            {"path": "arforge-bridge.exe", "status": "Valid", "timestamp_subject": "CN=Timestamp"},
        ],
        "manual_validation": {
            "release_owner_review": {
                "status": "pass",
                "reviewer": "release-owner",
                "reviewed_at_utc": "2026-06-30T00:05:00Z",
                "evidence": "desktop/release-evidence/desktop-upgrade-evidence.json",
                "notes": "Baseline/candidate runs, artifacts, SHA-256 values, version order and downgrade rejection reviewed.",
                "baseline_workflow_run_id": "1001",
                "candidate_workflow_run_id": "1002",
                "baseline_artifact_name": "Arforge Agent_0.7.0_x64_en-US.msi",
                "candidate_artifact_name": "Arforge Agent_0.7.1_x64_en-US.msi",
                "baseline_sha256": baseline_sha,
                "candidate_sha256": candidate_sha,
                "version_ordered": True,
                "downgrade_rejected": True,
            },
            "profile_preservation_review": {
                "status": "pass",
                "reviewer": "release-owner",
                "reviewed_at_utc": "2026-06-30T00:10:00Z",
                "evidence": "desktop/release-evidence/desktop-upgrade-evidence.json",
                "notes": "Real profile marker survived upgrade, downgrade rejection and uninstall cleanup.",
                "profile_preserved_through_upgrade": True,
                "profile_marker_path": marker_path,
                "profile_marker_sha256": marker_sha,
                "preserved_after_uninstall": True,
                "uninstall_cleanup_reviewed": True,
            },
        },
        "review": {
            "reviewer": "release-owner",
            "reviewed_at_utc": "2026-06-30T00:00:00Z",
            "baseline_workflow_run_id": "1001",
            "candidate_workflow_run_id": "1002",
            "baseline_artifact_name": "Arforge Agent_0.7.0_x64_en-US.msi",
            "candidate_artifact_name": "Arforge Agent_0.7.1_x64_en-US.msi",
            "baseline_sha256": baseline_sha,
            "candidate_sha256": candidate_sha,
            "version_ordered": True,
            "downgrade_rejected": True,
            "profile_marker_path": marker_path,
            "profile_marker_sha256": marker_sha,
            "uninstall_cleanup_reviewed": True,
        },
    }


def _write_evidence(root: Path, data: dict) -> Path:
    path = root / "desktop" / "release-evidence" / "desktop-upgrade-evidence.json"
    _write(path, json.dumps(data))
    return path


def test_upgrade_audit_blocks_when_only_workflow_and_verifier_exist(tmp_path):
    _upgrade_contract(tmp_path)

    report = build_upgrade_audit(tmp_path)

    assert report["status"] == "blocked"
    assert report["release_gate_ready"] is False
    assert report["summary"]["pass"] == 2
    assert report["summary"]["blocked"] == 5
    assert report["summary"]["manual"] == 3
    assert "signed_baseline_candidate" in format_upgrade_audit(report)


def test_upgrade_audit_accepts_complete_signed_upgrade_evidence(tmp_path):
    _upgrade_contract(tmp_path)
    _write_evidence(tmp_path, _complete_evidence(tmp_path))

    report = build_upgrade_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["release_gate_ready"] is True
    assert report["upgrade_ready"] is True
    assert report["downgrade_ready"] is True
    assert report["profile_ready"] is True
    assert report["summary"]["blocked"] == 0
    assert report["summary"]["manual"] == 0


def test_upgrade_audit_rejects_weak_or_inconsistent_evidence(tmp_path):
    _upgrade_contract(tmp_path)
    data = _complete_evidence(tmp_path)
    data["candidate"]["sha256"] = data["baseline"]["sha256"]
    data["downgrade"]["rejected"] = False
    data["profile"]["preserved_after_uninstall"] = False
    _write_evidence(tmp_path, data)

    report = build_upgrade_audit(tmp_path)
    by_id = {check["id"]: check for check in report["checks"]}

    assert report["release_gate_ready"] is False
    assert by_id["signed_baseline_candidate"]["status"] == "blocked"
    assert by_id["downgrade_rejected"]["status"] == "blocked"
    assert by_id["uninstall_cleanup"]["status"] == "blocked"


def test_upgrade_audit_rejects_missing_workflow_provenance(tmp_path):
    _upgrade_contract(tmp_path)
    data = _complete_evidence(tmp_path)
    data["baseline"].pop("artifact_name")
    data["candidate"]["workflow_run_id"] = "1001"
    data["candidate"]["sha256_reviewed"] = False
    _write_evidence(tmp_path, data)

    report = build_upgrade_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["signed_baseline_candidate"]

    assert report["release_gate_ready"] is False
    assert check["status"] == "blocked"
    assert "baseline.artifact_name(.msi)" in check["summary"]
    assert "candidate.sha256_reviewed=true" in check["summary"]
    assert "distinct_workflow_run_ids" in check["summary"]


def test_upgrade_audit_rejects_msi_hashes_not_bound_to_retained_files(tmp_path):
    _upgrade_contract(tmp_path)
    data = _complete_evidence(tmp_path)
    data["baseline"]["sha256"] = "0" * 64
    data["review"]["baseline_sha256"] = "0" * 64
    data["manual_validation"]["release_owner_review"]["baseline_sha256"] = "0" * 64
    data["candidate"]["artifact_name"] = "missing-candidate.msi"
    data["review"]["candidate_artifact_name"] = "missing-candidate.msi"
    data["manual_validation"]["release_owner_review"]["candidate_artifact_name"] = "missing-candidate.msi"
    _write_evidence(tmp_path, data)

    report = build_upgrade_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["signed_baseline_candidate"]

    assert report["upgrade_ready"] is False
    assert check["status"] == "blocked"
    assert "baseline.sha256_matches_file" in check["summary"]
    assert "candidate.retained_file_exists" in check["summary"]


def test_upgrade_audit_rejects_profile_marker_not_bound_to_file(tmp_path):
    _upgrade_contract(tmp_path)
    data = _complete_evidence(tmp_path)
    marker = tmp_path / "desktop" / "release-evidence" / "profiles" / "upgrade-profile-marker.txt"
    marker.write_text("tampered upgrade profile", encoding="utf-8")
    _write_evidence(tmp_path, data)

    report = build_upgrade_audit(tmp_path)
    checks = {item["id"]: item for item in report["checks"]}

    assert report["profile_ready"] is False
    assert checks["profile_preserved"]["status"] == "blocked"
    assert "marker_sha256_matches_file" in checks["profile_preserved"]["summary"]
    assert checks["upgrade_review_metadata"]["status"] == "blocked"
    assert "profile_marker_sha256_matches_file" in checks["upgrade_review_metadata"]["summary"]


def test_upgrade_audit_rejects_manual_passes_without_review_metadata(tmp_path):
    _upgrade_contract(tmp_path)
    data = _complete_evidence(tmp_path)
    data.pop("review")
    _write_evidence(tmp_path, data)

    report = build_upgrade_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["upgrade_review_metadata"]

    assert report["release_gate_ready"] is False
    assert check["status"] == "blocked"
    assert "review.reviewer" in check["summary"]
    assert "review.baseline_workflow_run_id" in check["summary"]
    assert "review.profile_marker_sha256" in check["summary"]


def test_upgrade_audit_rejects_string_pass_manual_validation_even_with_review_metadata(tmp_path):
    _upgrade_contract(tmp_path)
    data = _complete_evidence(tmp_path)
    data["manual_validation"] = {
        "release_owner_review": "pass",
        "profile_preservation_review": "pass",
    }
    _write_evidence(tmp_path, data)

    report = build_upgrade_audit(tmp_path)
    checks = {item["id"]: item for item in report["checks"]}

    assert report["release_gate_ready"] is False
    assert checks["upgrade_review_metadata"]["status"] == "pass"
    assert checks["release_owner_review"]["status"] == "blocked"
    assert "structured_object" in checks["release_owner_review"]["summary"]


def test_upgrade_audit_cli_writes_blocking_evidence(monkeypatch, tmp_path, capsys):
    _upgrade_contract(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["upgrade-audit", "build/desktop-upgrade-audit.json"]) == 1
    output = capsys.readouterr().out
    written = tmp_path / "build" / "desktop-upgrade-audit.json"

    assert "Desktop Signed Upgrade Audit" in output
    assert written.exists()
    data = json.loads(written.read_text(encoding="utf-8"))
    assert data["release_gate_ready"] is False
    assert data["summary"]["manual"] == 3


def test_release_gate_uses_upgrade_audit_contract(tmp_path):
    _upgrade_contract(tmp_path)

    report = build_release_gates(tmp_path)
    gate = {item["id"]: item for item in report["gates"]}["UPGRADE-01"]

    assert gate["status"] == "blocked"
    assert "Upgrade audit is not release-ready" in gate["summary"]
    assert "signed_baseline_candidate" in gate["summary"]


def test_local_upgrade_verifier_writes_structured_audit_evidence_contract():
    workflow = Path(".github/workflows/desktop-upgrade-matrix.yml")
    assert not workflow.exists()
    assert not Path("scripts/verify_desktop_upgrade.ps1").exists()
    assert Path("arforge/core/upgrade_audit.py").is_file()
    assert Path("packages/desktop").is_dir()
