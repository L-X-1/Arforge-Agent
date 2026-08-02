from __future__ import annotations

import json
from pathlib import Path

from arforge.cli import main
from arforge.core.release_audit_bundle import build_release_audit_bundle


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _minimal_release_tree(root: Path) -> None:
    _write(
        root / ".github" / "workflows" / "desktop-signed-candidate.yml",
        "\n".join(
            [
                "environment: desktop-release-candidate",
                "secrets.ARFORGE_WINDOWS_CERTIFICATE_BASE64",
                "secrets.ARFORGE_WINDOWS_CERTIFICATE_PASSWORD",
                "secrets.ARFORGE_WINDOWS_TIMESTAMP_URL",
                "actions/upload-artifact@v4",
            ]
        ),
    )
    _write(root / ".github" / "workflows" / "desktop-upgrade-matrix.yml", "environment: desktop-release-candidate\n")
    _write(root / "scripts" / "verify_desktop_upgrade.ps1", "throw 'Older baseline MSI was allowed to downgrade'\n")
    _write(
        root / "dist" / "release-manifest.json",
        json.dumps({"schema_version": 1, "source": {"commit": "a" * 40, "dirty": True}, "files": []}),
    )


def test_release_audit_bundle_writes_all_stage5_snapshots(tmp_path):
    _minimal_release_tree(tmp_path)

    summary = build_release_audit_bundle(tmp_path, "build/release-audit-snapshot")
    output = tmp_path / "build" / "release-audit-snapshot"

    assert summary["verdict"] == "DO_NOT_SHIP"
    assert summary["release_gate_ready"] is False
    assert summary["summary_path"] == "build/release-audit-snapshot/summary.json"
    assert summary["release_gates_path"] == "build/release-audit-snapshot/release-gates.json"
    assert [item["id"] for item in summary["audits"]] == [
        "installer",
        "signing",
        "upgrade",
        "accessibility",
        "governance",
        "staging",
        "ship",
    ]
    for filename in [
        "installer-audit.json",
        "signing-audit.json",
        "upgrade-audit.json",
        "accessibility-audit.json",
        "governance-audit.json",
        "staging-audit.json",
        "ship-audit.json",
        "release-gates.json",
        "summary.json",
    ]:
        assert (output / filename).is_file()
    written_summary = json.loads((output / "summary.json").read_text(encoding="utf-8"))
    assert written_summary["note"].startswith("Audit snapshot only")


def test_release_audit_bundle_rejects_output_outside_repo(tmp_path):
    _minimal_release_tree(tmp_path)
    outside = tmp_path.parent / "outside-release-audit"

    try:
        build_release_audit_bundle(tmp_path, outside)
    except ValueError as exc:
        assert "must stay inside repository root" in str(exc)
    else:
        raise AssertionError("outside output path must be rejected")


def test_release_audit_bundle_cli_writes_snapshot_and_fails_closed(monkeypatch, tmp_path, capsys):
    _minimal_release_tree(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["release-audit-bundle", "build/audit-bundle"]) == 1
    output = capsys.readouterr().out

    assert "Release Audit Bundle" in output
    assert "DO_NOT_SHIP" in output
    assert (tmp_path / "build" / "audit-bundle" / "summary.json").is_file()
    assert (tmp_path / "build" / "audit-bundle" / "release-gates.json").is_file()
