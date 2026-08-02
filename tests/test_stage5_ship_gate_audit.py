from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

from arforge.cli import main
from arforge.core.release_gates import build_release_gates
from arforge.core.ship_gate_audit import build_ship_gate_audit, format_ship_gate_audit


def _write(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(data, encoding="utf-8")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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


def _load_ship_writer():
    script = Path(__file__).resolve().parents[1] / "scripts" / "write_ship_gate_evidence.py"
    spec = importlib.util.spec_from_file_location("write_ship_gate_evidence", script)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _manifest(root: Path, *, dirty: bool = False) -> None:
    wheel = root / "dist" / "arforge_agent-0.7.0-py3-none-any.whl"
    sbom = root / "dist" / "arforge-agent.cdx.json"
    lockfile = root / "requirements-release.lock"
    _write(wheel, b"wheel")
    _write(sbom, json.dumps({"bomFormat": "CycloneDX", "components": []}))
    _write(lockfile, "sqlalchemy==2.0.0 --hash=sha256:abc\n")
    _write(
        root / "dist" / "release-manifest.json",
        json.dumps(
            {
                "schema_version": 1,
                "product": "Arforge Agent",
                "version": "0.7.0",
                "source": {"commit": "a" * 40, "dirty": dirty},
                "lockfile": {"name": "requirements-release.lock", "sha256": _sha256(lockfile)},
                "files": [
                    {"name": wheel.name, "bytes": wheel.stat().st_size, "sha256": _sha256(wheel)},
                    {"name": sbom.name, "bytes": sbom.stat().st_size, "sha256": _sha256(sbom)},
                ],
            }
        ),
    )


def _approval(root: Path) -> None:
    manifest = root / "dist" / "release-manifest.json"
    manifest_data = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else {}
    rollback_plan = root / "docs" / "release" / "rollback-plan-0.7.0.md"
    release_notes = root / "docs" / "release" / "release-notes-0.7.0.md"
    _write(rollback_plan, "# Rollback plan\n\nWithdraw candidate and restore the last approved version.\n")
    _write(release_notes, "# Release notes\n\nInternal candidate with known alpha limitations.\n")
    prior_gates = []
    for index, gate_id in enumerate(["SIGN-01", "SIGN-02", "REL-01", "UPGRADE-01", "A11Y-01", "GOV-01", "STAGE-01"], start=1):
        evidence_path = root / "build" / "release-evidence" / f"{gate_id.lower()}-snapshot.json"
        _write(evidence_path, json.dumps({"id": gate_id, "status": "pass", "index": index}))
        prior_gates.append(
            {
                "id": gate_id,
                "status": "pass",
                "evidence_path": evidence_path.relative_to(root).as_posix(),
                "evidence_sha256": _sha256(evidence_path),
                "captured_at_utc": "2026-06-30T00:05:00Z",
            }
        )
    _write(
        root / "build" / "release-evidence" / "ship-gate-approval.json",
        json.dumps(
            {
                "schema_version": 1,
                "approver": "release-owner",
                "approved_at_utc": "2026-06-30T00:00:00Z",
                "release_channel": "internal-candidate",
                "artifact_set_id": "arforge-agent-0.7.0-20260630",
                "release_manifest_sha256": _sha256(manifest) if manifest.exists() else "",
                "version": manifest_data.get("version"),
                "source_commit": manifest_data.get("source", {}).get("commit"),
                "prior_gate_snapshot": {
                    "captured_at_utc": "2026-06-30T00:05:00Z",
                    "artifact_set_id": "arforge-agent-0.7.0-20260630",
                    "release_candidate_id": "arforge-0.7.0-rc1",
                    "signed_candidate_workflow_run_id": "9001",
                    "verdict": "READY_FOR_SHIP",
                },
                "prior_gates": prior_gates,
                "review": {
                    "reviewer": "release-owner",
                    "reviewed_at_utc": "2026-06-30T00:10:00Z",
                    "release_manifest_sha256": _sha256(manifest) if manifest.exists() else "",
                    "source_commit": manifest_data.get("source", {}).get("commit"),
                    "version": manifest_data.get("version"),
                    "release_channel": "internal-candidate",
                    "artifact_set_id": "arforge-agent-0.7.0-20260630",
                    "prior_gate_snapshot_captured_at_utc": "2026-06-30T00:05:00Z",
                    "release_candidate_id": "arforge-0.7.0-rc1",
                    "signed_candidate_workflow_run_id": "9001",
                    "release_owner_approval": True,
                    "artifact_promotion_locked": True,
                    "rollback_plan_reviewed": True,
                    "docs_release_notes_reviewed": True,
                    "known_limitations_reviewed": True,
                    "no_open_blocking_gates": True,
                    "rollback_plan_path": rollback_plan.relative_to(root).as_posix(),
                    "rollback_plan_sha256": _sha256(rollback_plan),
                    "release_notes_path": release_notes.relative_to(root).as_posix(),
                    "release_notes_sha256": _sha256(release_notes),
                },
                "manual_validation": {
                    "release_owner_approval": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:11:00Z",
                        "evidence": "release-owner approval ticket RO-1234",
                        "notes": "Release owner approved the immutable artifact set.",
                        "release_owner_approval": True,
                        "approver": "release-owner",
                        "release_manifest_sha256": _sha256(manifest) if manifest.exists() else "",
                        "artifact_set_id": "arforge-agent-0.7.0-20260630",
                        "no_open_blocking_gates": True,
                    },
                    "artifact_promotion_lock": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:12:00Z",
                        "evidence": "immutable artifact store lock AL-5678",
                        "notes": "Promotion target points to immutable artifacts only.",
                        "artifact_promotion_locked": True,
                        "artifact_set_id": "arforge-agent-0.7.0-20260630",
                        "promotion_target": "internal-candidate",
                        "immutable_storage": True,
                        "replace_in_place_blocked": True,
                    },
                    "rollback_plan_review": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:13:00Z",
                        "evidence": "rollback review ticket RR-9012",
                        "notes": "Rollback and downgrade path reviewed.",
                        "rollback_plan_reviewed": True,
                        "rollback_plan_path": rollback_plan.relative_to(root).as_posix(),
                        "rollback_plan_sha256": _sha256(rollback_plan),
                        "downgrade_or_rollback_path_reviewed": True,
                        "rollback_owner": "release-owner",
                    },
                    "docs_release_notes_review": {
                        "status": "pass",
                        "reviewer": "release-owner",
                        "reviewed_at_utc": "2026-06-30T00:14:00Z",
                        "evidence": "release notes review ticket RN-3456",
                        "notes": "Release notes, known limitations and user docs reviewed.",
                        "docs_release_notes_reviewed": True,
                        "release_notes_path": release_notes.relative_to(root).as_posix(),
                        "release_notes_sha256": _sha256(release_notes),
                        "known_limitations_reviewed": True,
                        "user_docs_reviewed": True,
                    },
                },
            }
        ),
    )


def _prior_gate_args(root: Path, *, blocked: str | None = None) -> list[str]:
    args: list[str] = []
    for gate_id in ["SIGN-01", "SIGN-02", "REL-01", "UPGRADE-01", "A11Y-01", "GOV-01", "STAGE-01"]:
        path = root / "prior-gates" / f"{gate_id.lower()}.json"
        status = "blocked" if gate_id == blocked else "pass"
        _write(path, json.dumps({"id": gate_id, "status": status, "release_gate_ready": status == "pass"}))
        args.extend(["--prior-gate", f"{gate_id}={path}"])
    return args


def _final_review_files(root: Path) -> tuple[Path, Path, Path, Path]:
    rollback_plan = root / "docs" / "release" / "rollback-plan-0.7.0.md"
    release_notes = root / "docs" / "release" / "release-notes-0.7.0.md"
    owner_proof = root / "reviews" / "release-owner-approval.txt"
    promotion_proof = root / "reviews" / "artifact-promotion-lock.txt"
    _write(rollback_plan, "# Rollback plan\n\nWithdraw candidate and restore the last approved version.\n")
    _write(release_notes, "# Release notes\n\nInternal candidate with known alpha limitations.\n")
    _write(owner_proof, "release owner approved immutable artifact set\n")
    _write(promotion_proof, "artifact store is immutable and replace-in-place is blocked\n")
    return rollback_plan, release_notes, owner_proof, promotion_proof


def test_ship_gate_audit_fails_closed_without_manifest(tmp_path):
    report = build_ship_gate_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["status"] == "blocked"
    assert report["release_gate_ready"] is False
    assert checks["release_manifest_present"]["status"] == "blocked"
    assert checks["final_approval_metadata"]["status"] == "blocked"
    assert checks["prior_gate_snapshot"]["status"] == "blocked"
    assert checks["release_owner_approval"]["status"] == "manual"
    assert "Release gate ready: false" in format_ship_gate_audit(report)


def test_ship_gate_audit_blocks_dirty_source_manifest(tmp_path):
    _manifest(tmp_path, dirty=True)
    _approval(tmp_path)

    report = build_ship_gate_audit(tmp_path)
    source = {check["id"]: check for check in report["checks"]}["source_clean"]

    assert report["release_gate_ready"] is False
    assert source["status"] == "blocked"
    assert "dirty source tree" in source["summary"]


def test_ship_gate_audit_detects_artifact_tampering(tmp_path):
    _manifest(tmp_path)
    _approval(tmp_path)
    _write(tmp_path / "dist" / "arforge_agent-0.7.0-py3-none-any.whl", b"tampered")

    report = build_ship_gate_audit(tmp_path)
    artifact = {check["id"]: check for check in report["checks"]}["artifact_hashes"]

    assert report["release_gate_ready"] is False
    assert artifact["status"] == "blocked"
    assert "validation failed" in artifact["summary"]


def test_ship_gate_audit_rejects_approval_not_bound_to_manifest(tmp_path):
    _manifest(tmp_path)
    _approval(tmp_path)
    approval = tmp_path / "build" / "release-evidence" / "ship-gate-approval.json"
    data = json.loads(approval.read_text(encoding="utf-8"))
    data["release_manifest_sha256"] = "0" * 64
    data["source_commit"] = "b" * 40
    approval.write_text(json.dumps(data), encoding="utf-8")

    report = build_ship_gate_audit(tmp_path)
    metadata = {check["id"]: check for check in report["checks"]}["final_approval_metadata"]

    assert report["release_gate_ready"] is False
    assert metadata["status"] == "blocked"
    assert "release_manifest_sha256" in metadata["summary"]
    assert "source_commit_matches_manifest" in metadata["summary"]


def test_ship_gate_audit_rejects_prior_gate_snapshot_without_metadata(tmp_path):
    _manifest(tmp_path)
    _approval(tmp_path)
    approval = tmp_path / "build" / "release-evidence" / "ship-gate-approval.json"
    data = json.loads(approval.read_text(encoding="utf-8"))
    data.pop("prior_gate_snapshot")
    for gate in data["prior_gates"]:
        gate.pop("evidence_sha256")
    approval.write_text(json.dumps(data), encoding="utf-8")

    report = build_ship_gate_audit(tmp_path)
    snapshot = {check["id"]: check for check in report["checks"]}["prior_gate_snapshot"]

    assert report["release_gate_ready"] is False
    assert snapshot["status"] == "blocked"
    assert "prior_gate_snapshot.captured_at_utc" in snapshot["summary"]
    assert "prior_gate_snapshot.release_candidate_id" in snapshot["summary"]
    assert "SIGN-01.evidence_sha256" in snapshot["summary"]


def test_ship_gate_audit_rejects_prior_gate_snapshot_hash_not_bound_to_file(tmp_path):
    _manifest(tmp_path)
    _approval(tmp_path)
    approval = tmp_path / "build" / "release-evidence" / "ship-gate-approval.json"
    data = json.loads(approval.read_text(encoding="utf-8"))
    data["prior_gates"][0]["evidence_sha256"] = "0" * 64
    data["prior_gates"][1].pop("evidence_path")
    approval.write_text(json.dumps(data), encoding="utf-8")

    report = build_ship_gate_audit(tmp_path)
    snapshot = {check["id"]: check for check in report["checks"]}["prior_gate_snapshot"]

    assert report["release_gate_ready"] is False
    assert snapshot["status"] == "blocked"
    assert "SIGN-01.evidence_sha256_matches_path" in snapshot["summary"]
    assert "SIGN-02.evidence_path" in snapshot["summary"]


def test_ship_gate_audit_rejects_manual_passes_without_final_review_metadata(tmp_path):
    _manifest(tmp_path)
    _approval(tmp_path)
    approval = tmp_path / "build" / "release-evidence" / "ship-gate-approval.json"
    data = json.loads(approval.read_text(encoding="utf-8"))
    data.pop("review")
    approval.write_text(json.dumps(data), encoding="utf-8")

    report = build_ship_gate_audit(tmp_path)
    review = {check["id"]: check for check in report["checks"]}["final_review_metadata"]

    assert report["release_gate_ready"] is False
    assert review["status"] == "manual"
    assert "Structured final manual review metadata is required" in review["summary"]


def test_ship_gate_audit_rejects_final_review_docs_not_bound_to_files(tmp_path):
    _manifest(tmp_path)
    _approval(tmp_path)
    release_notes = tmp_path / "docs" / "release" / "release-notes-0.7.0.md"
    release_notes.write_text("# Tampered release notes\n", encoding="utf-8")

    report = build_ship_gate_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["release_gate_ready"] is False
    assert checks["final_review_metadata"]["status"] == "blocked"
    assert "release_notes_sha256_matches_path" in checks["final_review_metadata"]["summary"]
    assert checks["docs_release_notes_review"]["status"] == "blocked"
    assert "release_notes_sha256_matches_path" in checks["docs_release_notes_review"]["summary"]


def test_ship_gate_audit_rejects_string_pass_manual_validation_even_with_final_review_metadata(tmp_path):
    _manifest(tmp_path)
    _approval(tmp_path)
    approval = tmp_path / "build" / "release-evidence" / "ship-gate-approval.json"
    data = json.loads(approval.read_text(encoding="utf-8"))
    data["manual_validation"] = {
        "release_owner_approval": "pass",
        "artifact_promotion_lock": "pass",
        "rollback_plan_review": "pass",
        "docs_release_notes_review": "pass",
    }
    approval.write_text(json.dumps(data), encoding="utf-8")

    report = build_ship_gate_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["release_gate_ready"] is False
    assert checks["final_review_metadata"]["status"] == "pass"
    assert checks["release_owner_approval"]["status"] == "blocked"
    assert "structured_object" in checks["release_owner_approval"]["summary"]


def test_ship_gate_audit_passes_with_complete_final_evidence(tmp_path):
    _manifest(tmp_path)
    _approval(tmp_path)

    report = build_ship_gate_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["release_gate_ready"] is True
    assert report["summary"]["blocked"] == 0
    assert report["summary"]["manual"] == 0
    assert sorted(report["evidence_files"]) == [
        "build/release-evidence/ship-gate-approval.json",
        "dist/release-manifest.json",
    ]


def test_ship_audit_cli_writes_json_evidence(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["ship-audit", "build/ship-audit.json"]) == 1
    output = capsys.readouterr().out
    written = tmp_path / "build" / "ship-audit.json"

    assert "Final Artifact Ship Audit" in output
    assert written.exists()
    data = json.loads(written.read_text(encoding="utf-8"))
    assert data["release_gate_ready"] is False
    assert data["summary"]["manual"] == 4
    assert data["summary"]["blocked"] == 9


def test_release_gate_uses_ship_gate_audit_contract(tmp_path):
    _release_workflows(tmp_path)
    _manifest(tmp_path, dirty=True)

    report = build_release_gates(tmp_path)
    gate = {item["id"]: item for item in report["gates"]}["SHIP-01"]

    assert gate["status"] == "blocked"
    assert "Final Ship Gate audit is not release-ready" in gate["summary"]
    assert "source_clean" in gate["summary"]


def test_ship_gate_evidence_writer_rejects_blocked_prior_gate(tmp_path, capsys):
    writer = _load_ship_writer()
    _manifest(tmp_path)
    rollback_plan, release_notes, owner_proof, promotion_proof = _final_review_files(tmp_path)

    result = writer.main(
        [
            "--root",
            str(tmp_path),
            "--approver",
            "release-owner",
            "--release-channel",
            "internal-candidate",
            "--artifact-set-id",
            "arforge-agent-0.7.0-20260701",
            "--release-candidate-id",
            "arforge-0.7.0-rc1",
            "--signed-candidate-workflow-run-id",
            "9001",
            "--rollback-plan",
            str(rollback_plan),
            "--release-notes",
            str(release_notes),
            "--release-owner-approval-proof",
            str(owner_proof),
            "--artifact-promotion-lock-proof",
            str(promotion_proof),
            *_prior_gate_args(tmp_path, blocked="GOV-01"),
            "--release-owner-approved",
            "--artifact-promotion-locked",
            "--immutable-storage",
            "--replace-in-place-blocked",
            "--rollback-plan-reviewed",
            "--downgrade-or-rollback-path-reviewed",
            "--docs-release-notes-reviewed",
            "--known-limitations-reviewed",
            "--user-docs-reviewed",
            "--no-open-blocking-gates",
        ]
    )

    assert result == 2
    assert "prior gate evidence is not passing for GOV-01" in capsys.readouterr().err


def test_ship_gate_evidence_writer_outputs_audit_consumable_package(tmp_path):
    writer = _load_ship_writer()
    _manifest(tmp_path)
    rollback_plan, release_notes, owner_proof, promotion_proof = _final_review_files(tmp_path)

    result = writer.main(
        [
            "--root",
            str(tmp_path),
            "--approver",
            "release-owner",
            "--release-channel",
            "internal-candidate",
            "--artifact-set-id",
            "arforge-agent-0.7.0-20260701",
            "--release-candidate-id",
            "arforge-0.7.0-rc1",
            "--signed-candidate-workflow-run-id",
            "9001",
            "--rollback-plan",
            str(rollback_plan),
            "--release-notes",
            str(release_notes),
            "--release-owner-approval-proof",
            str(owner_proof),
            "--artifact-promotion-lock-proof",
            str(promotion_proof),
            *_prior_gate_args(tmp_path),
            "--release-owner-approved",
            "--artifact-promotion-locked",
            "--immutable-storage",
            "--replace-in-place-blocked",
            "--rollback-plan-reviewed",
            "--downgrade-or-rollback-path-reviewed",
            "--docs-release-notes-reviewed",
            "--known-limitations-reviewed",
            "--user-docs-reviewed",
            "--no-open-blocking-gates",
        ]
    )

    assert result == 0
    report = build_ship_gate_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["release_gate_ready"] is True
    assert sorted(report["evidence_files"]) == [
        "desktop/release-evidence/ship-gate-approval.json",
        "dist/release-manifest.json",
    ]
