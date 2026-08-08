from __future__ import annotations

import json
from pathlib import Path

from arforge.product.direct_dispatch import dispatch
from arforge.cli import main
from arforge.core.release_gates import build_release_gates, format_release_gates


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
                "Verify signing readiness without exposing secrets",
                "actions/upload-artifact@v4",
            ]
        ),
    )
    _write(
        root / ".github" / "workflows" / "desktop-upgrade-matrix.yml",
        "environment: desktop-release-candidate\n",
    )
    _write(
        root / "scripts" / "verify_desktop_upgrade.ps1",
        "if ($true) { throw 'Older baseline MSI was allowed to downgrade' }\n",
    )
    _write(
        root / "build" / "release-evidence-2026-06-29-signing" / "signing-readiness.json",
        json.dumps(
            {
                "schema_version": 1,
                "ready": False,
                "blocker_codes": [
                    "HTTPS_TIMESTAMP_URL_REQUIRED",
                    "CERTIFICATE_THUMBPRINT_REQUIRED",
                    "GIT_REMOTE_REQUIRED",
                ],
                "timestamp": {"configured": False, "https": False, "host": None},
                "git": {"commit": "a" * 40, "remote_count": 0, "remote_names": []},
                "frozen_sidecar_count": 1,
            }
        ),
    )
    _write(
        root / "dist" / "release-manifest.json",
        json.dumps({"source": {"commit": "a" * 40, "dirty": True}, "files": []}),
    )
    _write(root / "docs" / "SHIP_GATE_REPORT_2026-06-18.md", "DO NOT SHIP\n")


def test_release_gates_fail_closed_without_real_stage5_evidence(tmp_path):
    _minimal_release_tree(tmp_path)

    report = build_release_gates(tmp_path)
    by_id = {gate["id"]: gate for gate in report["gates"]}

    assert report["verdict"] == "DO_NOT_SHIP"
    assert report["product_status"] == f"{__import__('arforge').__version__} / DO NOT SHIP"
    assert by_id["INSTALLER-01"]["status"] == "blocked"
    assert by_id["REL-01"]["status"] == "blocked"
    assert by_id["SIGN-01"]["status"] == "blocked"
    assert "signing_readiness" in by_id["SIGN-01"]["summary"]
    assert by_id["SIGN-02"]["status"] == "blocked"
    assert by_id["UPGRADE-01"]["status"] == "blocked"
    assert by_id["A11Y-01"]["status"] == "blocked"
    assert by_id["GOV-01"]["status"] == "blocked"
    assert by_id["STAGE-01"]["status"] == "blocked"
    assert by_id["SHIP-01"]["status"] == "blocked"
    assert "Verdict: DO_NOT_SHIP" in format_release_gates(report)


def test_release_gates_recognize_successful_signing_inputs_but_require_artifacts(tmp_path):
    _minimal_release_tree(tmp_path)
    readiness = tmp_path / "build" / "release-evidence-2026-06-29-signing" / "signing-readiness.json"
    readiness.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "ready": True,
                "blocker_codes": [],
                "timestamp": {"configured": True, "https": True, "host": "timestamp.example"},
                "certificate": {"found": True, "has_private_key": True},
                "git": {"commit": "a" * 40, "remote_count": 1, "remote_names": ["origin"]},
                "frozen_sidecar_count": 1,
            }
        ),
        encoding="utf-8",
    )

    report = build_release_gates(tmp_path)
    by_id = {gate["id"]: gate for gate in report["gates"]}

    assert report["verdict"] == "DO_NOT_SHIP"
    assert by_id["SIGN-01"]["status"] == "blocked"
    assert by_id["SIGN-02"]["status"] == "blocked"
    assert "signed_candidate_artifacts" in by_id["SIGN-01"]["summary"]
    assert by_id["UPGRADE-01"]["status"] == "blocked"


def test_release_gates_are_exposed_as_read_only_bridge_method(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    response = dispatch({"id": 1, "version": "1.2", "method": "release.gates"})

    assert response["ok"] is False
    assert response["error"]["code"] == "METHOD_NOT_FOUND"



def test_ship_gate_cli_returns_nonzero_until_release_gates_pass(monkeypatch, tmp_path, capsys):
    _minimal_release_tree(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["ship-gate"]) == 1
    output = capsys.readouterr().out

    assert "Release Ship Gate" in output
    assert "DO_NOT_SHIP" in output
    assert "INSTALLER-01" in output
    assert "SIGN-01" in output
