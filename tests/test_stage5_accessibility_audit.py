from __future__ import annotations

import hashlib
import json
from pathlib import Path

from arforge.cli import main
from arforge.core.accessibility_audit import build_desktop_accessibility_audit, format_accessibility_audit
from arforge.core.release_gates import build_release_gates

SIGNED_ARTIFACT_NAME = "Arforge-Agent-0.7.0.msi"


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _manual_proofs(root: Path) -> dict[str, tuple[str, str]]:
    evidence_dir = root / "desktop" / "release-evidence"
    proof_files = {
        "keyboard_navigation": ("a11y-keyboard-2026-06-29.txt", "keyboard tab-order proof"),
        "screen_reader": ("a11y-nvda-2026-06-29.txt", "screen reader proof"),
        "scaling_125": ("a11y-scale-125.png", "scale 125 proof"),
        "scaling_150": ("a11y-scale-150.png", "scale 150 proof"),
        "scaling_200": ("a11y-scale-200.png", "scale 200 proof"),
    }
    retained: dict[str, tuple[str, str]] = {}
    for check_id, (filename, contents) in proof_files.items():
        relative = f"desktop/release-evidence/{filename}"
        proof = evidence_dir / filename
        _write(proof, contents)
        retained[check_id] = (relative, _sha256_file(proof))
    return retained


def _desktop_sources(root: Path) -> None:
    _write(
        root / "desktop" / "src" / "App.tsx",
        """
export function App() {
  return <div>
    <a className="skip-link" href="#main">Skip</a>
    <main id="main" tabIndex={-1}>
      <button aria-label="Refresh"><RefreshCw /></button>
      <button>Open</button>
    </main>
  </div>;
}
""",
    )
    _write(
        root / "desktop" / "src" / "styles.css",
        """
button:focus-visible, a:focus-visible { outline: 3px solid #fff; }
@media (prefers-reduced-motion: reduce) { * { animation-duration: .01ms !important; } }
""",
    )


def _release_contract(root: Path) -> None:
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


def _signed_candidate(root: Path) -> str:
    artifact = root / "desktop" / "release-evidence" / SIGNED_ARTIFACT_NAME
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(b"retained signed accessibility candidate")
    artifact_sha = _sha256_file(artifact)
    _write(
        root / "desktop" / "release-evidence" / "signed-candidate.json",
        json.dumps(
            {
                "schema_version": 1,
                "status": "pass",
                "workflow_run_url": "https://github.com/example/arforge/actions/runs/9001",
                "workflow_run_id": "9001",
                "commit": "a" * 40,
                "protected_environment": "desktop-release-candidate",
                "required_reviewers_approved": True,
                "signing_material_removed": True,
                "artifacts": [
                    {
                        "name": SIGNED_ARTIFACT_NAME,
                        "sha256": artifact_sha,
                        "signature_status": "Valid",
                        "timestamped": True,
                    }
                ],
            }
        ),
    )
    return artifact_sha


def _complete_manual_evidence(
    artifact_sha: str | None = None,
    manual_proofs: dict[str, tuple[str, str]] | None = None,
) -> dict:
    proofs = manual_proofs or {}

    def proof(check_id: str, fallback: str) -> dict[str, str]:
        relative, digest = proofs.get(check_id, (fallback, "a" * 64))
        return {"evidence_path": relative, "evidence_sha256": digest}

    return {
        "schema_version": 1,
        "reviewer": "release-owner",
        "validated_at_utc": "2026-06-29T00:00:00Z",
        "evidence": "desktop/release-evidence/accessibility-2026-06-29.json",
        "desktop_artifact": {
            "name": SIGNED_ARTIFACT_NAME,
            "sha256": artifact_sha or "a" * 64,
            "signed_candidate_workflow_run_id": "9001",
            "signed_candidate_commit": "a" * 40,
            "signature_status": "Valid",
            "timestamped": True,
        },
        "environment": {
            "os": "Windows 11 23H2",
            "screen_reader": "NVDA 2026.1",
            "display_scaling_tested": [125, 150, 200],
        },
        "manual_validation": {
            "keyboard_navigation": {
                "status": "pass",
                "evidence": "desktop/release-evidence/a11y-keyboard-2026-06-29.txt",
                **proof("keyboard_navigation", "desktop/release-evidence/a11y-keyboard-2026-06-29.txt"),
                "notes": "Tab order and focus traps reviewed.",
                "duration_minutes": 12,
            },
            "screen_reader": {
                "status": "pass",
                "tool": "NVDA 2026.1",
                "evidence": "desktop/release-evidence/a11y-nvda-2026-06-29.txt",
                **proof("screen_reader", "desktop/release-evidence/a11y-nvda-2026-06-29.txt"),
                "notes": "Names, roles and state changes reviewed.",
                "duration_minutes": 15,
            },
            "scaling_125": {
                "status": "pass",
                "scale_percent": 125,
                "evidence": "desktop/release-evidence/a11y-scale-125.png",
                **proof("scaling_125", "desktop/release-evidence/a11y-scale-125.png"),
                "notes": "No clipping or overlap at 125 percent.",
                "duration_minutes": 5,
            },
            "scaling_150": {
                "status": "pass",
                "scale_percent": 150,
                "evidence": "desktop/release-evidence/a11y-scale-150.png",
                **proof("scaling_150", "desktop/release-evidence/a11y-scale-150.png"),
                "notes": "No clipping or overlap at 150 percent.",
                "duration_minutes": 5,
            },
            "scaling_200": {
                "status": "pass",
                "scale_percent": 200,
                "evidence": "desktop/release-evidence/a11y-scale-200.png",
                **proof("scaling_200", "desktop/release-evidence/a11y-scale-200.png"),
                "notes": "No clipping or overlap at 200 percent.",
                "duration_minutes": 5,
            },
        },
    }


def test_accessibility_audit_requires_native_manual_evidence(tmp_path):
    _desktop_sources(tmp_path)

    report = build_desktop_accessibility_audit(tmp_path)

    assert report["status"] == "blocked"
    assert report["release_gate_ready"] is False
    assert report["summary"]["blocked"] == 0
    assert report["summary"]["manual"] == 6
    assert "manual_evidence_metadata" in report["missing_manual_evidence"]
    assert "keyboard_navigation" in report["missing_manual_evidence"]
    assert "Release gate ready: false" in format_accessibility_audit(report)


def test_accessibility_audit_accepts_complete_manual_evidence(tmp_path):
    _desktop_sources(tmp_path)
    artifact_sha = _signed_candidate(tmp_path)
    manual_proofs = _manual_proofs(tmp_path)
    _write(
        tmp_path / "desktop" / "release-evidence" / "accessibility-2026-06-29.json",
        json.dumps(_complete_manual_evidence(artifact_sha, manual_proofs)),
    )

    report = build_desktop_accessibility_audit(tmp_path)

    assert report["status"] == "pass"
    assert report["release_gate_ready"] is True
    assert report["summary"]["manual"] == 0
    assert report["summary"]["blocked"] == 0
    assert report["evidence_files"] == ["desktop/release-evidence/accessibility-2026-06-29.json"]


def test_accessibility_audit_rejects_evidence_not_bound_to_signed_candidate(tmp_path):
    _desktop_sources(tmp_path)
    artifact_sha = _signed_candidate(tmp_path)
    data = _complete_manual_evidence(artifact_sha, _manual_proofs(tmp_path))
    data["desktop_artifact"]["signed_candidate_workflow_run_id"] = "9002"
    data["desktop_artifact"]["sha256"] = "b" * 64
    _write(
        tmp_path / "desktop" / "release-evidence" / "accessibility-2026-06-29.json",
        json.dumps(data),
    )

    report = build_desktop_accessibility_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["manual_evidence_metadata"]

    assert report["release_gate_ready"] is False
    assert check["status"] == "blocked"
    assert "desktop_artifact.workflow_run_matches_signed_candidate" in check["summary"]
    assert "desktop_artifact.matches_signed_candidate_artifact" in check["summary"]


def test_accessibility_audit_rejects_signed_artifact_sha_not_bound_to_file(tmp_path):
    _desktop_sources(tmp_path)
    _signed_candidate(tmp_path)
    forged_sha = "b" * 64
    candidate_path = tmp_path / "desktop" / "release-evidence" / "signed-candidate.json"
    candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
    candidate["artifacts"][0]["sha256"] = forged_sha
    _write(candidate_path, json.dumps(candidate))
    data = _complete_manual_evidence(forged_sha, _manual_proofs(tmp_path))
    _write(
        tmp_path / "desktop" / "release-evidence" / "accessibility-2026-06-29.json",
        json.dumps(data),
    )

    report = build_desktop_accessibility_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["manual_evidence_metadata"]

    assert report["release_gate_ready"] is False
    assert check["status"] == "blocked"
    assert "desktop_artifact.sha256_matches_file" in check["summary"]


def test_accessibility_audit_rejects_manual_validation_evidence_hash_not_bound_to_file(tmp_path):
    _desktop_sources(tmp_path)
    artifact_sha = _signed_candidate(tmp_path)
    manual_proofs = _manual_proofs(tmp_path)
    data = _complete_manual_evidence(artifact_sha, manual_proofs)
    proof_path = tmp_path / manual_proofs["keyboard_navigation"][0]
    proof_path.write_text("tampered proof", encoding="utf-8")
    _write(
        tmp_path / "desktop" / "release-evidence" / "accessibility-2026-06-29.json",
        json.dumps(data),
    )

    report = build_desktop_accessibility_audit(tmp_path)
    check = {item["id"]: item for item in report["checks"]}["keyboard_navigation"]

    assert report["release_gate_ready"] is False
    assert check["status"] == "blocked"
    assert "evidence_sha256_matches_file" in check["summary"]


def test_accessibility_audit_rejects_pass_only_manual_evidence_without_metadata(tmp_path):
    _desktop_sources(tmp_path)
    _write(
        tmp_path / "desktop" / "release-evidence" / "accessibility-2026-06-29.json",
        json.dumps(
            {
                "schema_version": 1,
                "reviewer": "release-owner",
                "validated_at_utc": "2026-06-29T00:00:00Z",
                "evidence": "desktop/release-evidence/accessibility-2026-06-29.json",
                "manual_validation": {
                    "keyboard_navigation": "pass",
                    "screen_reader": "pass",
                    "scaling_125": "pass",
                    "scaling_150": "pass",
                    "scaling_200": "pass",
                },
            }
        ),
    )

    report = build_desktop_accessibility_audit(tmp_path)
    by_id = {check["id"]: check for check in report["checks"]}

    assert report["release_gate_ready"] is False
    assert by_id["manual_evidence_metadata"]["status"] == "blocked"
    assert "desktop_artifact.sha256" in by_id["manual_evidence_metadata"]["summary"]


def test_accessibility_audit_rejects_string_pass_manual_validation_even_with_metadata(tmp_path):
    _desktop_sources(tmp_path)
    artifact_sha = _signed_candidate(tmp_path)
    data = _complete_manual_evidence(artifact_sha, _manual_proofs(tmp_path))
    data["manual_validation"] = {
        "keyboard_navigation": "pass",
        "screen_reader": "pass",
        "scaling_125": "pass",
        "scaling_150": "pass",
        "scaling_200": "pass",
    }
    _write(
        tmp_path / "desktop" / "release-evidence" / "accessibility-2026-06-29.json",
        json.dumps(data),
    )

    report = build_desktop_accessibility_audit(tmp_path)
    by_id = {check["id"]: check for check in report["checks"]}

    assert report["release_gate_ready"] is False
    assert by_id["manual_evidence_metadata"]["status"] == "pass"
    assert by_id["keyboard_navigation"]["status"] == "blocked"
    assert "structured_object" in by_id["keyboard_navigation"]["summary"]


def test_accessibility_audit_cli_writes_blocking_evidence(monkeypatch, tmp_path, capsys):
    _desktop_sources(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["accessibility-audit", "build/desktop-accessibility-audit.json"]) == 1
    output = capsys.readouterr().out
    written = tmp_path / "build" / "desktop-accessibility-audit.json"

    assert "Desktop Accessibility Audit" in output
    assert written.exists()
    data = json.loads(written.read_text(encoding="utf-8"))
    assert data["release_gate_ready"] is False
    assert data["missing_manual_evidence"] == [
        "manual_evidence_metadata",
        "keyboard_navigation",
        "screen_reader",
        "scaling_125",
        "scaling_150",
        "scaling_200",
    ]


def test_release_gate_uses_accessibility_audit_contract(tmp_path):
    _desktop_sources(tmp_path)
    _release_contract(tmp_path)

    report = build_release_gates(tmp_path)
    gate = {item["id"]: item for item in report["gates"]}["A11Y-01"]

    assert gate["status"] == "blocked"
    assert "Desktop accessibility audit is not release-ready" in gate["summary"]
    assert "manual_evidence_metadata" in gate["summary"]
    assert "keyboard_navigation" in gate["summary"]


def test_accessibility_evidence_writer_contract():
    assert not Path("scripts/write_desktop_accessibility_evidence.ps1").exists()
    assert Path("arforge/core/accessibility_audit.py").is_file()
    assert Path("packages/desktop").is_dir()
