from __future__ import annotations

import json
import hashlib
import importlib.util
import subprocess
from pathlib import Path

from arforge.cli import main
from arforge.core.governance_audit import build_governance_audit, format_governance_audit
from arforge.core.release_gates import build_release_gates


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)


def _init_repo(root: Path) -> None:
    _git(root, "init")
    _git(root, "config", "user.email", "release@example.test")
    _git(root, "config", "user.name", "Release Test")
    _git(root, "remote", "add", "origin", "https://example.test/arforge.git")


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


def _governance_evidence(root: Path) -> None:
    backup_text = "postgres backup dump"
    _write(root / "build" / "release-evidence" / "arforge-2026-06-30.dump", backup_text)
    manual_evidence = {
        "credential_rotation": ("governance/credential-rotation-20260630.md", "rotated production credentials"),
        "external_copies_review": ("governance/external-copies-20260630.md", "reviewed external release copies"),
        "protected_remote_review": ("governance/protected-remote-20260630.md", "reviewed protected remote"),
        "legacy_files_decision": ("governance/root-file-decisions-20260630.md", "reviewed root file decisions"),
    }
    for relative, text in manual_evidence.values():
        _write(root / "build" / "release-evidence" / relative, text)
    _write(
        root / "build" / "release-evidence" / "postgres-restore-drill.json",
        json.dumps(
            {
                "schema_version": 1,
                "status": "pass",
                "isolated_restore": True,
                "target_isolated": True,
                "backup": {"name": "arforge-2026-06-30.dump", "sha256": _sha256_text(backup_text)},
                "restore": {
                    "target_database": "arforge_restore_drill_20260630",
                    "completed_at_utc": "2026-06-30T00:00:00Z",
                },
                "catalog_verified": True,
                "schema_match": True,
                "table_counts_match": True,
                "record_counts_match": True,
                "tables": [
                    {"name": "sessions", "source_count": 12, "restored_count": 12},
                    {"name": "messages", "source_count": 48, "restored_count": 48},
                ],
                "representative_records_match": True,
                "destructive_target": False,
            }
        ),
    )
    _write(
        root / "build" / "release-evidence" / "credential-cleanup.json",
        json.dumps(
            {
                "schema_version": 1,
                "reviewer": "release-owner",
                "reviewed_at_utc": "2026-06-30T00:00:00Z",
                "source_commit": "a" * 40,
                "remote_url": "https://example.test/arforge.git",
                "branch_protection": {"branch": "main", "reviewed": True},
                "release_environment": {
                    "name": "desktop-release-candidate",
                    "required_reviewers": True,
                    "secrets_reviewed": True,
                },
                "manual_validation": {
                    "credential_rotation": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:05:00Z",
                        "evidence": "secops/rotation-ticket-20260630",
                        "evidence_path": manual_evidence["credential_rotation"][0],
                        "evidence_sha256": _sha256_text(manual_evidence["credential_rotation"][1]),
                        "notes": "Production/API/database credentials rotated or invalidated.",
                        "production_credentials_rotated": True,
                        "rotation_ticket": "SEC-2026-0630",
                    },
                    "external_copies_review": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:10:00Z",
                        "evidence": "release-secrets-review-20260630.md",
                        "evidence_path": manual_evidence["external_copies_review"][0],
                        "evidence_sha256": _sha256_text(manual_evidence["external_copies_review"][1]),
                        "notes": "External copies, backups and release secrets reviewed.",
                        "external_copies_reviewed": True,
                        "untracked_release_secrets": False,
                    },
                    "protected_remote_review": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:15:00Z",
                        "evidence": "github/environment/desktop-release-candidate",
                        "evidence_path": manual_evidence["protected_remote_review"][0],
                        "evidence_sha256": _sha256_text(manual_evidence["protected_remote_review"][1]),
                        "notes": "Remote, branch protection and protected release environment reviewed.",
                        "branch_protection_verified": True,
                        "release_environment_reviewed": True,
                    },
                    "legacy_files_decision": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:20:00Z",
                        "evidence": "governance/root-file-decisions-20260630.md",
                        "evidence_path": manual_evidence["legacy_files_decision"][0],
                        "evidence_sha256": _sha256_text(manual_evidence["legacy_files_decision"][1]),
                        "notes": "Root-level anomalies reviewed with explicit decisions.",
                        "root_anomalies_reviewed": True,
                        "decisions": [{"path": "README.md", "decision": "keep"}],
                    },
                },
            }
        ),
    )


def _commit_all(root: Path) -> None:
    _git(root, "add", ".")
    _git(root, "commit", "-m", "release evidence")


def _load_governance_writer():
    script = Path(__file__).resolve().parents[1] / "scripts" / "write_governance_evidence.py"
    spec = importlib.util.spec_from_file_location("write_governance_evidence", script)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_governance_audit_fails_closed_without_release_evidence(tmp_path):
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "Arforge release candidate\n")
    _commit_all(tmp_path)

    report = build_governance_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["status"] == "blocked"
    assert report["release_gate_ready"] is False
    assert checks["git_repository"]["status"] == "pass"
    assert checks["git_clean_baseline"]["status"] == "pass"
    assert checks["git_remote"]["status"] == "pass"
    assert checks["postgres_restore_drill"]["status"] == "blocked"
    assert checks["governance_evidence_metadata"]["status"] == "manual"
    assert checks["credential_rotation"]["status"] == "manual"
    assert "Release gate ready: false" in format_governance_audit(report)


def test_governance_audit_passes_with_clean_repo_and_complete_evidence(tmp_path):
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "Arforge release candidate\n")
    _governance_evidence(tmp_path)
    _commit_all(tmp_path)

    report = build_governance_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["release_gate_ready"] is True
    assert report["summary"]["blocked"] == 0
    assert report["summary"]["manual"] == 0
    assert sorted(report["evidence_files"]) == [
        "build/release-evidence/credential-cleanup.json",
        "build/release-evidence/postgres-restore-drill.json",
    ]


def test_governance_audit_detects_repo_secret_patterns(tmp_path):
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "postgresql://alice:secret@example.test:5432/arforge\n")
    _commit_all(tmp_path)

    report = build_governance_audit(tmp_path)
    secret_scan = {check["id"]: check for check in report["checks"]}["repository_secret_scan"]

    assert secret_scan["status"] == "blocked"
    assert "Credential-like patterns" in secret_scan["summary"]
    assert secret_scan["details"]["findings"][0]["path"] == "README.md"


def test_governance_audit_rejects_restore_evidence_without_table_comparison(tmp_path):
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "Arforge release candidate\n")
    _write(
        tmp_path / "build" / "release-evidence" / "postgres-restore-drill.json",
        json.dumps(
            {
                "schema_version": 1,
                "status": "pass",
                "isolated_restore": True,
                "target_isolated": True,
                "schema_match": True,
            }
        ),
    )
    _commit_all(tmp_path)

    report = build_governance_audit(tmp_path)
    restore = {check["id"]: check for check in report["checks"]}["postgres_restore_drill"]

    assert restore["status"] == "blocked"
    assert "backup.sha256" in restore["summary"]
    assert "tables[].source_count/restored_count" in restore["summary"]


def test_governance_audit_rejects_restore_backup_hash_not_bound_to_file(tmp_path):
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "Arforge release candidate\n")
    _governance_evidence(tmp_path)
    restore_path = tmp_path / "build" / "release-evidence" / "postgres-restore-drill.json"
    data = json.loads(restore_path.read_text(encoding="utf-8"))
    data["backup"]["sha256"] = "0" * 64
    restore_path.write_text(json.dumps(data), encoding="utf-8")
    _commit_all(tmp_path)

    report = build_governance_audit(tmp_path)
    restore = {check["id"]: check for check in report["checks"]}["postgres_restore_drill"]

    assert report["release_gate_ready"] is False
    assert restore["status"] == "blocked"
    assert "backup.sha256_matches_file" in restore["summary"]


def test_governance_audit_rejects_manual_evidence_hash_not_bound_to_file(tmp_path):
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "Arforge release candidate\n")
    _governance_evidence(tmp_path)
    proof = tmp_path / "build" / "release-evidence" / "governance" / "credential-rotation-20260630.md"
    proof.write_text("tampered credential rotation proof", encoding="utf-8")
    _commit_all(tmp_path)

    report = build_governance_audit(tmp_path)
    credential_rotation = {check["id"]: check for check in report["checks"]}["credential_rotation"]

    assert report["release_gate_ready"] is False
    assert credential_rotation["status"] == "blocked"
    assert "evidence_sha256_matches_file" in credential_rotation["summary"]


def test_governance_audit_rejects_manual_passes_without_metadata(tmp_path):
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "Arforge release candidate\n")
    _write(
        tmp_path / "build" / "release-evidence" / "credential-cleanup.json",
        json.dumps(
            {
                "schema_version": 1,
                "reviewer": "release-owner",
                "manual_validation": {
                    "credential_rotation": "pass",
                    "external_copies_review": "pass",
                    "protected_remote_review": "pass",
                    "legacy_files_decision": "pass",
                },
            }
        ),
    )
    _commit_all(tmp_path)

    report = build_governance_audit(tmp_path)
    metadata = {check["id"]: check for check in report["checks"]}["governance_evidence_metadata"]

    assert report["release_gate_ready"] is False
    assert metadata["status"] == "blocked"
    assert "reviewed_at_utc" in metadata["summary"]
    assert "source_commit" in metadata["summary"]
    assert "release_environment.name=desktop-release-candidate" in metadata["summary"]


def test_governance_audit_rejects_string_pass_manual_validation_even_with_metadata(tmp_path):
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "Arforge release candidate\n")
    _governance_evidence(tmp_path)
    evidence = tmp_path / "build" / "release-evidence" / "credential-cleanup.json"
    data = json.loads(evidence.read_text(encoding="utf-8"))
    data["manual_validation"] = {
        "credential_rotation": "pass",
        "external_copies_review": "pass",
        "protected_remote_review": "pass",
        "legacy_files_decision": "pass",
    }
    evidence.write_text(json.dumps(data), encoding="utf-8")
    _commit_all(tmp_path)

    report = build_governance_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["release_gate_ready"] is False
    assert checks["governance_evidence_metadata"]["status"] == "pass"
    assert checks["credential_rotation"]["status"] == "blocked"
    assert "structured_object" in checks["credential_rotation"]["summary"]


def test_governance_audit_cli_writes_json_evidence(monkeypatch, tmp_path, capsys):
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "Arforge release candidate\n")
    _commit_all(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["governance-audit", "build/governance-audit.json"]) == 1
    output = capsys.readouterr().out
    written = tmp_path / "build" / "governance-audit.json"

    assert "Release Governance Audit" in output
    assert written.exists()
    data = json.loads(written.read_text(encoding="utf-8"))
    assert data["release_gate_ready"] is False
    assert data["summary"]["manual"] == 5


def test_release_gate_uses_governance_audit_contract(tmp_path):
    _init_repo(tmp_path)
    _release_workflows(tmp_path)
    _write(
        tmp_path / "build" / "release-evidence-2026-06-29-signing" / "signing-readiness.json",
        json.dumps({"ready": False, "blocker_codes": ["CERTIFICATE_THUMBPRINT_REQUIRED"], "timestamp": {"https": False}}),
    )
    _write(tmp_path / "dist" / "release-manifest.json", json.dumps({"source": {"dirty": False}, "files": []}))
    _commit_all(tmp_path)

    report = build_release_gates(tmp_path)
    gate = {item["id"]: item for item in report["gates"]}["GOV-01"]

    assert gate["status"] == "blocked"
    assert "Governance audit is not release-ready" in gate["summary"]
    assert "postgres_restore_drill" in gate["summary"]


def test_governance_evidence_writer_rejects_missing_required_confirmation(tmp_path, capsys):
    writer = _load_governance_writer()
    backup = tmp_path / "backup.dump"
    backup.write_text("backup", encoding="utf-8")
    proof = tmp_path / "proof.txt"
    proof.write_text("proof", encoding="utf-8")

    result = writer.main(
        [
            "--root",
            str(tmp_path),
            "--reviewer",
            "release-owner",
            "--source-commit",
            "a" * 40,
            "--remote-url",
            "https://example.test/arforge.git",
            "--backup",
            str(backup),
            "--target-database",
            "arforge_restore_drill_20260701",
            "--table-count",
            "sessions:2:2",
            "--credential-rotation-proof",
            str(proof),
            "--external-copies-proof",
            str(proof),
            "--protected-remote-proof",
            str(proof),
            "--legacy-files-decision-proof",
            str(proof),
            "--rotation-ticket",
            "SEC-2026-0701",
            "--production-credentials-rotated",
            "--legacy-decision",
            "README.md=keep",
        ]
    )

    assert result == 2
    assert "--external-copies-reviewed is required" in capsys.readouterr().err


def test_governance_evidence_writer_outputs_audit_consumable_package(tmp_path):
    writer = _load_governance_writer()
    _init_repo(tmp_path)
    _write(tmp_path / "README.md", "Arforge release candidate\n")
    _commit_all(tmp_path)
    backup = tmp_path / "backup.dump"
    backup.write_text("postgres backup dump", encoding="utf-8")
    proofs = {
        "credential": tmp_path / "credential-proof.md",
        "external": tmp_path / "external-proof.md",
        "remote": tmp_path / "remote-proof.md",
        "legacy": tmp_path / "legacy-proof.md",
    }
    for name, path in proofs.items():
        path.write_text(f"{name} reviewed\n", encoding="utf-8")

    result = writer.main(
        [
            "--root",
            str(tmp_path),
            "--reviewer",
            "release-owner",
            "--backup",
            str(backup),
            "--target-database",
            "arforge_restore_drill_20260701",
            "--table-count",
            "sessions:12:12",
            "--table-count",
            "messages:48:48",
            "--credential-rotation-proof",
            str(proofs["credential"]),
            "--external-copies-proof",
            str(proofs["external"]),
            "--protected-remote-proof",
            str(proofs["remote"]),
            "--legacy-files-decision-proof",
            str(proofs["legacy"]),
            "--rotation-ticket",
            "SEC-2026-0701",
            "--production-credentials-rotated",
            "--external-copies-reviewed",
            "--no-untracked-release-secrets",
            "--branch-protection-verified",
            "--release-environment-reviewed",
            "--required-reviewers-approved",
            "--release-secrets-reviewed",
            "--root-anomalies-reviewed",
            "--legacy-decision",
            "README.md=keep",
        ]
    )

    assert result == 0
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "governance evidence")
    report = build_governance_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["release_gate_ready"] is True
    assert (tmp_path / "desktop" / "release-evidence" / "credential-cleanup.json").is_file()
    assert (tmp_path / "desktop" / "release-evidence" / "postgres-restore-drill.json").is_file()
