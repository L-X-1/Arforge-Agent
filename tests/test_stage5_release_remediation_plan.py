from __future__ import annotations

import json
from pathlib import Path

from arforge.cli import main
from arforge.core.release_remediation_plan import build_release_remediation_plan


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
    _write(root / "scripts" / "write_governance_evidence.py", "# helper\n")
    _write(root / "scripts" / "write_staging_load_evidence.py", "# helper\n")
    _write(root / "scripts" / "write_ship_gate_evidence.py", "# helper\n")
    _write(
        root / "dist" / "release-manifest.json",
        json.dumps({"schema_version": 1, "source": {"commit": "a" * 40, "dirty": True}, "files": []}),
    )


def test_release_remediation_plan_lists_blocked_gates_with_actions(tmp_path):
    _minimal_release_tree(tmp_path)

    report = build_release_remediation_plan(tmp_path)
    by_gate = {item["gate"]: item for item in report["items"]}

    assert report["verdict"] == "DO_NOT_SHIP"
    assert report["remaining"] == 9
    assert list(by_gate) == [
        "INSTALLER-01",
        "SIGN-01",
        "SIGN-02",
        "REL-01",
        "UPGRADE-01",
        "A11Y-01",
        "GOV-01",
        "STAGE-01",
        "SHIP-01",
    ]
    assert by_gate["GOV-01"]["audit_command"] == "arforge governance-audit"
    assert by_gate["GOV-01"]["collection_helpers"] == ["scripts/write_governance_evidence.py"]
    assert by_gate["STAGE-01"]["collection_helpers"] == ["scripts/write_staging_load_evidence.py"]
    assert by_gate["SHIP-01"]["collection_helpers"] == ["scripts/write_ship_gate_evidence.py"]
    assert by_gate["SIGN-01"]["open_checks"]
    assert by_gate["SIGN-01"]["next_action"]


def test_release_remediation_plan_cli_writes_json_and_fails_closed(monkeypatch, tmp_path, capsys):
    _minimal_release_tree(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["release-remediation-plan", "build/remediation.json"]) == 1
    output = capsys.readouterr().out
    written = tmp_path / "build" / "remediation.json"

    assert "Release Remediation Plan" in output
    assert "DO_NOT_SHIP" in output
    assert written.is_file()
    data = json.loads(written.read_text(encoding="utf-8"))
    assert data["remaining"] == 9
    assert data["items"][0]["gate"] == "INSTALLER-01"
