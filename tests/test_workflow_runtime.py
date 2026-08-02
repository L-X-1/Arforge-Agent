"""Contract tests for validated file-backed workflows."""

from __future__ import annotations

import json
from dataclasses import replace

import pytest


def _definition():
    from arforge.workflow_runtime import parse_workflow

    return parse_workflow(
        {
            "schema_version": 1,
            "name": "review_flow",
            "description": "Review then verify a change.",
            "steps": [
                {"id": "review", "title": "Review", "prompt": "Review the change."},
                {
                    "id": "verify",
                    "title": "Verify",
                    "prompt": "Run targeted verification.",
                    "depends_on": ["review"],
                },
            ],
        }
    )


def test_workflow_rejects_unsupported_execution_fields_and_cycles():
    from arforge.workflow_runtime import WorkflowValidationError, parse_workflow

    with pytest.raises(WorkflowValidationError, match="unsupported fields"):
        parse_workflow(
            {
                "name": "unsafe",
                "steps": [{"id": "step", "prompt": "Do work", "command": "powershell"}],
            }
        )
    with pytest.raises(WorkflowValidationError, match="cycle"):
        parse_workflow(
            {
                "name": "cycle",
                "steps": [
                    {"id": "one", "prompt": "one", "depends_on": ["two"]},
                    {"id": "two", "prompt": "two", "depends_on": ["one"]},
                ],
            }
        )


def test_preview_is_deterministic_and_never_invokes_a_runner():
    from arforge.workflow_runtime import preview_workflow

    report = preview_workflow(_definition())

    assert report.dry_run is True
    assert [step.status for step in report.steps] == ["planned", "planned"]
    assert report.steps[1].output == "depends_on: review"


def test_execution_stops_after_a_non_continuable_failure():
    from arforge.workflow_runtime import execute_workflow

    called = []

    def runner(step):
        called.append(step.id)
        raise RuntimeError("provider key sk-123456789012345678901 must not be shown")

    report = execute_workflow(_definition(), runner)

    assert called == ["review"]
    assert report.success is False
    assert report.steps[0].status == "failed"
    assert "sk-123456789012345678901" not in report.steps[0].error
    assert len(report.steps) == 1


def test_execution_allows_dependents_after_an_explicitly_continuable_failure():
    from arforge.workflow_runtime import execute_workflow

    definition = _definition()
    definition = replace(definition, steps=(replace(definition.steps[0], continue_on_error=True), *definition.steps[1:]))
    report = execute_workflow(
        definition,
        lambda step: (_ for _ in ()).throw(RuntimeError("expected")) if step.id == "review" else "verified",
    )

    assert [step.status for step in report.steps] == ["failed", "completed"]


def test_cli_validates_and_previews_a_workspace_workflow(monkeypatch, tmp_path, capsys):
    from arforge.cli import main

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    workflow_path = tmp_path / ".arforge" / "workflows" / "review.json"
    workflow_path.parent.mkdir(parents=True)
    workflow_path.write_text(
        json.dumps({"name": "review_flow", "steps": [{"id": "review", "prompt": "Review the change."}]}),
        encoding="utf-8",
    )

    assert main(["workflows", "validate", ".arforge/workflows/review.json", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["valid"] is True
    assert main(["workflows", "run", ".arforge/workflows/review.json", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["dry_run"] is True
    assert payload["steps"][0]["status"] == "planned"
    assert (tmp_path / "profile" / "workflows" / "runs" / "review_flow.json").is_file()


def test_cli_refuses_workflow_outside_workspace(monkeypatch, tmp_path, capsys):
    from arforge.cli import main

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({"name": "outside", "steps": [{"id": "one", "prompt": "x"}]}), encoding="utf-8")
    monkeypatch.chdir(workspace)

    assert main(["workflows", "validate", str(outside)]) == 2
    assert "inside the workspace" in capsys.readouterr().err
