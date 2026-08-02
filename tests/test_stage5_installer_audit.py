from __future__ import annotations

import json
from pathlib import Path

from arforge.cli import main
from arforge.core.installer_audit import build_installer_audit, format_installer_audit
from arforge.core.release_gates import build_release_gates


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _sha256_text(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _artifact(root: Path, relative: str, text: str) -> dict[str, object]:
    path = root / "build" / "release-evidence" / relative
    _write(path, text)
    return {"path": relative, "size_bytes": len(text.encode("utf-8")), "sha256": _sha256_text(text)}


def _workflows(root: Path) -> None:
    body = "\n".join(
        [
            "npm run tauri build -- --bundles nsis,msi",
            "scripts/verify_desktop_nsis.ps1",
            "scripts/verify_desktop_installer.ps1",
            "actions/upload-artifact@v4",
            "desktop/release-evidence",
        ]
    )
    _write(root / ".github" / "workflows" / "desktop-package.yml", body)
    _write(root / ".github" / "workflows" / "desktop-signed-candidate.yml", body)


def _msi_evidence(root: Path, *, manual: bool = True) -> None:
    msi_artifact = _artifact(root, "msi/Arforge Agent_0.7.0_x64_en-US.msi", "msi artifact")
    nsis_artifact = _artifact(root, "nsis/Arforge Agent_0.7.0_x64-setup.exe", "nsis artifact")
    profile_marker = "profiles/msi-profile-marker.txt"
    _write(root / "build" / "release-evidence" / profile_marker, "preserved msi profile")
    evidence = {
        "schema_version": 3,
        "signatures_required": False,
        "installed_app": "C:\\Program Files\\Arforge Agent\\arforge-agent-desktop.exe",
        "installed_sidecar": "C:\\Program Files\\Arforge Agent\\arforge-bridge.exe",
        "installer_exit_code": 0,
        "uninstaller_exit_code": 0,
        "install_scope_contract": {
            "action": "ForceArforgePerMachineInstallDir",
            "property": "INSTALLDIR",
            "target": "[ProgramFiles64Folder]Arforge Agent",
            "execute_sequence": 51,
            "installed_under_program_files": True,
        },
        "sidecar_started": True,
        "profile_preserved_after_uninstall": True,
        "profile_marker_path": profile_marker,
        "profile_marker_sha256": _sha256_text("preserved msi profile"),
        "artifacts": [msi_artifact, nsis_artifact],
    }
    if manual:
        evidence["manual_validation"] = {
            "protected_runner_review": {
                "status": "pass",
                "reviewer": "release-owner",
                "reviewed_at_utc": "2026-06-30T00:05:00Z",
                "evidence": "github/actions/windows-release-runner-01",
                "notes": "Protected elevated Windows runner and all-users MSI context reviewed.",
                "protected_runner": "windows-release-runner-01",
                "uac_elevated": True,
                "all_users_msi": True,
                "program_files_install_reviewed": True,
            },
            "installer_log_review": {
                "status": "pass",
                "reviewer": "release-owner",
                "reviewed_at_utc": "2026-06-30T00:10:00Z",
                "evidence": "build/release-evidence/msi-install.log; build/release-evidence/msi-uninstall.log",
                "notes": "MSI verbose install and uninstall logs reviewed.",
                "log_sha256": {
                    "msi-install.log": _sha256_text("install log"),
                    "msi-uninstall.log": _sha256_text("uninstall log"),
                },
                "install_log_reviewed": True,
                "uninstall_log_reviewed": True,
            },
        }
        evidence["review"] = {
            "reviewer": "release-owner",
            "reviewed_at_utc": "2026-06-30T00:00:00Z",
            "protected_runner": "windows-release-runner-01",
            "uac_elevated": True,
            "all_users_msi": True,
            "artifact_sha256": {"msi": msi_artifact["sha256"], "exe": nsis_artifact["sha256"]},
            "log_sha256": {
                "msi-install.log": _sha256_text("install log"),
                "msi-uninstall.log": _sha256_text("uninstall log"),
            },
        }
    _write(root / "build" / "release-evidence" / "desktop-installer-evidence.json", json.dumps(evidence))
    _write(root / "build" / "release-evidence" / "msi-install.log", "install log")
    _write(root / "build" / "release-evidence" / "msi-uninstall.log", "uninstall log")


def _nsis_evidence(root: Path) -> None:
    profile_marker = "profiles/nsis-profile-marker.txt"
    _write(root / "build" / "release-evidence" / profile_marker, "preserved nsis profile")
    _write(
        root / "build" / "release-evidence" / "desktop-nsis-evidence.json",
        json.dumps(
            {
                "schema_version": 1,
                "signatures_required": False,
                "installer": {
                    "path": "Arforge Agent_0.7.0_x64-setup.exe",
                    "size_bytes": 100,
                    "sha256": "d" * 64,
                    "install_exit_code": 0,
                    "uninstall_exit_code": 0,
                },
                "installed_app_sha256": "e" * 64,
                "sidecar_started": True,
                "profile_preserved_after_uninstall": True,
                "profile_marker_path": profile_marker,
                "profile_marker_sha256": _sha256_text("preserved nsis profile"),
            }
        ),
    )


def test_installer_audit_fails_closed_without_evidence(tmp_path):
    report = build_installer_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["status"] == "blocked"
    assert report["release_gate_ready"] is False
    assert checks["msi_lifecycle"]["status"] == "blocked"
    assert checks["nsis_lifecycle"]["status"] == "blocked"
    assert "Installer ready: false" in format_installer_audit(report)


def test_installer_audit_passes_with_complete_lifecycle_evidence(tmp_path):
    _workflows(tmp_path)
    _msi_evidence(tmp_path)
    _nsis_evidence(tmp_path)

    report = build_installer_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["installer_ready"] is True
    assert report["release_gate_ready"] is True
    assert report["summary"]["blocked"] == 0
    assert report["summary"]["manual"] == 0


def test_installer_audit_blocks_missing_verbose_logs(tmp_path):
    _workflows(tmp_path)
    _msi_evidence(tmp_path)
    _nsis_evidence(tmp_path)
    (tmp_path / "build" / "release-evidence" / "msi-install.log").unlink()

    report = build_installer_audit(tmp_path)
    logs = {check["id"]: check for check in report["checks"]}["msi_verbose_logs"]

    assert report["release_gate_ready"] is False
    assert logs["status"] == "blocked"
    assert "verbose logs" in logs["summary"]


def test_installer_audit_rejects_artifact_manifest_not_bound_to_files(tmp_path):
    _workflows(tmp_path)
    _msi_evidence(tmp_path)
    _nsis_evidence(tmp_path)
    evidence = tmp_path / "build" / "release-evidence" / "desktop-installer-evidence.json"
    data = json.loads(evidence.read_text(encoding="utf-8"))
    data["artifacts"][0]["sha256"] = "0" * 64
    data["artifacts"][1]["path"] = "missing/Arforge Agent_0.7.0_x64-setup.exe"
    evidence.write_text(json.dumps(data), encoding="utf-8")

    report = build_installer_audit(tmp_path)
    artifacts = {check["id"]: check for check in report["checks"]}["installer_artifacts"]

    assert report["installer_ready"] is False
    assert artifacts["status"] == "blocked"
    assert "sha256_matches_file" in artifacts["summary"]
    assert "exists" in artifacts["summary"]


def test_installer_audit_rejects_profile_marker_not_bound_to_file(tmp_path):
    _workflows(tmp_path)
    _msi_evidence(tmp_path)
    _nsis_evidence(tmp_path)
    marker = tmp_path / "build" / "release-evidence" / "profiles" / "msi-profile-marker.txt"
    marker.write_text("tampered profile marker", encoding="utf-8")

    report = build_installer_audit(tmp_path)
    msi = {check["id"]: check for check in report["checks"]}["msi_lifecycle"]

    assert report["release_gate_ready"] is False
    assert msi["status"] == "blocked"
    assert "profile_marker_sha256_matches_file" in msi["summary"]


def test_installer_audit_rejects_manual_passes_without_review_metadata(tmp_path):
    _workflows(tmp_path)
    _msi_evidence(tmp_path)
    _nsis_evidence(tmp_path)
    evidence = tmp_path / "build" / "release-evidence" / "desktop-installer-evidence.json"
    data = json.loads(evidence.read_text(encoding="utf-8"))
    data.pop("review")
    evidence.write_text(json.dumps(data), encoding="utf-8")

    report = build_installer_audit(tmp_path)
    review = {check["id"]: check for check in report["checks"]}["installer_review_metadata"]

    assert report["release_gate_ready"] is False
    assert review["status"] == "blocked"
    assert "review.reviewer" in review["summary"]
    assert "review.msi_artifact_sha256" in review["summary"]
    assert "review.log_sha256.msi-install.log" in review["summary"]


def test_installer_audit_rejects_string_pass_manual_validation_even_with_review_metadata(tmp_path):
    _workflows(tmp_path)
    _msi_evidence(tmp_path)
    _nsis_evidence(tmp_path)
    evidence = tmp_path / "build" / "release-evidence" / "desktop-installer-evidence.json"
    data = json.loads(evidence.read_text(encoding="utf-8"))
    data["manual_validation"] = {
        "protected_runner_review": "pass",
        "installer_log_review": "pass",
    }
    evidence.write_text(json.dumps(data), encoding="utf-8")

    report = build_installer_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["release_gate_ready"] is False
    assert checks["installer_review_metadata"]["status"] == "pass"
    assert checks["protected_runner_review"]["status"] == "blocked"
    assert "structured_object" in checks["protected_runner_review"]["summary"]


def test_installer_audit_cli_writes_json_evidence(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["installer-audit", "build/installer-audit.json"]) == 1
    output = capsys.readouterr().out
    written = tmp_path / "build" / "installer-audit.json"

    assert "Desktop Installer Lifecycle Audit" in output
    assert written.exists()
    data = json.loads(written.read_text(encoding="utf-8"))
    assert data["release_gate_ready"] is False
    assert data["summary"]["manual"] == 3


def test_release_gate_uses_installer_audit_contract(tmp_path):
    _workflows(tmp_path)

    report = build_release_gates(tmp_path)
    gate = {item["id"]: item for item in report["gates"]}["INSTALLER-01"]

    assert gate["status"] == "blocked"
    assert "Installer audit is not release-ready" in gate["summary"]
    assert "msi_lifecycle" in gate["summary"]


def test_installer_verifiers_write_structured_audit_evidence_contract():
    assert not Path("scripts/verify_desktop_installer.ps1").exists()
    assert not Path("scripts/verify_desktop_nsis.ps1").exists()
    assert Path("arforge/core/installer_audit.py").is_file()
    assert Path("packages/desktop").is_dir()
