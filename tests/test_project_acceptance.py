from __future__ import annotations

import json
from pathlib import Path

from arforge.core.project_acceptance import (
    build_project_acceptance_report,
    load_project_manifest,
    run_project_acceptance,
)


def test_project_manifest_requires_complete_lifecycle_and_known_capabilities():
    manifest = load_project_manifest()

    assert manifest["required_phases"] == [
        "clean_build",
        "unit_tests",
        "integration_tests",
        "negative_path",
        "release_artifact",
        "repeatability",
    ]
    python_service = next(
        project for project in manifest["projects"] if project["id"] == "python-service"
    )
    assert set(python_service["phases"]) == set(manifest["required_phases"])
    assert python_service["minimum_files"] >= 7


def test_project_report_fails_closed_without_project_depth_evidence(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))

    report = build_project_acceptance_report()

    assert report["status"] == "incomplete"
    assert report["total"] == 54
    assert report["verified"] == 0
    assert report["unverified"] == 54


def test_python_service_runs_all_phases_and_verifies_only_its_capabilities(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))

    run = run_project_acceptance(["python-service"])
    report = build_project_acceptance_report()

    assert run["passed"] == 1
    assert run["failed"] == 0
    assert report["status"] == "incomplete"
    assert report["verified"] == 5
    project = report["projects"][0]
    assert project["verified"] is True
    assert all(
        phase["passed"]
        for phase in project["evidence"]["phase_results"].values()
    )
    assert len(project["evidence"]["phase_results"]["repeatability"]["commands"]) == 2
    verified_ids = {
        row["id"] for row in report["capabilities"] if row["verified"]
    }
    assert verified_ids == {
        "lang-python",
        "framework-fastapi",
        "db-sqlite",
        "tool-pip",
        "test-pytest",
    }


def test_project_evidence_is_integrity_protected(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    run = run_project_acceptance(["python-service"])
    evidence_path = Path(run["results"][0]["evidence_path"])
    payload = json.loads(evidence_path.read_text(encoding="utf-8"))
    payload["phase_results"]["negative_path"]["passed"] = False
    evidence_path.write_text(json.dumps(payload), encoding="utf-8")

    report = build_project_acceptance_report()

    assert report["verified"] == 0
