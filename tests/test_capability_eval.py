from __future__ import annotations

import json

import pytest

from arforge.core import capability_eval
from arforge.cli import main
from arforge.core.capability_eval import (
    builtin_capability_eval_tasks,
    format_capability_eval_report,
    report_to_dict,
    run_capability_eval,
    self_correct_eval_tasks,
)


QUALITY_COMMANDS = (
    "python -m ruff check arforge tests config.py main.py",
    "python -m pytest -q",
    "node bin/arforge.js capabilities evaluate --json",
    "node bin/arforge.js doctor --json",
    "bun run lint",
    "bun run typecheck",
    "bun run brand:check",
)


def quality_workflow_task(monkeypatch, tmp_path, commands):
    workflow = tmp_path / ".github" / "workflows" / "ci.yml"
    workflow.parent.mkdir(parents=True)
    workflow.write_text("\n".join(f"- run: {command}" for command in commands), encoding="utf-8")
    monkeypatch.setattr(capability_eval, "__file__", str(tmp_path / "arforge" / "core" / "capability_eval.py"))
    task = next(task for task in builtin_capability_eval_tasks() if task.id == "ci1-quality-workflow")
    return task.run(tmp_path / "evaluation")


def test_quality_workflow_accepts_current_ts_launcher_contract(monkeypatch, tmp_path):
    passed, detail = quality_workflow_task(monkeypatch, tmp_path, QUALITY_COMMANDS)
    assert passed, detail


@pytest.mark.parametrize("missing", QUALITY_COMMANDS)
def test_quality_workflow_rejects_each_missing_quality_command(monkeypatch, tmp_path, missing):
    passed, detail = quality_workflow_task(monkeypatch, tmp_path, [command for command in QUALITY_COMMANDS if command != missing])
    assert not passed
    assert missing in detail


def test_capability_eval_covers_required_agent_contracts():
    tasks = builtin_capability_eval_tasks()

    assert {task.id for task in tasks} == {
        "g6-resume-artifacts",
        "g11-impacted-tests",
        "g13-interrupt-control-file",
        "g19-danger-guard",
        "g20-replay-report",
        "ma1-hard-timeout",
        "ma2-progress-cancel",
        "ma3-role-boundaries",
        "ma4-unified-worker-runtime",
        "pr1-thinking-tool-choice",
        "rd1-package-version",
        "ci1-quality-workflow",
        "ob1-telemetry-isolation",
        "sc0-created-test-order",
        "sc1-failure-feedback",
        "sc2-repeat-call-block",
        "sc3-syntax-reflection",
        "sc4-tool-message-order",
        "sc5-unexecuted-tool-text-block",
        "sc6-cleanup-tool-switch",
        "sc7-verification-gate",
        "sc8-post-edit-consistency",
        "sc9-test-fix-loop",
        "sc10-cross-file-imports",
        "sc11-transient-retry",
        "sc12-auto-test-loop",
        }


def test_capability_eval_runs_all_local_contracts(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))

    report = run_capability_eval()
    output = format_capability_eval_report(report)

    assert report.total == 26
    assert report.passed == 26
    assert report.success_rate == 1.0
    assert "g13-interrupt-control-file" in output
    assert "ma1-hard-timeout" in output
    assert "sc1-failure-feedback" in output
    assert "GOV" not in output


def test_self_correct_eval_subset_runs(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))

    report = run_capability_eval(self_correct_eval_tasks(), suite="self_correct")
    payload = report_to_dict(report)

    assert report.total == 13
    assert report.passed == 13
    assert payload["suite"] == "self_correct"
    assert {case["task_id"] for case in payload["cases"]} == {
        "sc0-created-test-order",
        "sc1-failure-feedback",
        "sc2-repeat-call-block",
        "sc3-syntax-reflection",
        "sc4-tool-message-order",
        "sc5-unexecuted-tool-text-block",
        "sc6-cleanup-tool-switch",
        "sc7-verification-gate",
        "sc8-post-edit-consistency",
        "sc9-test-fix-loop",
        "sc10-cross-file-imports",
        "sc11-transient-retry",
        "sc12-auto-test-loop",
    }


def test_capability_eval_cli_outputs_json(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))

    assert main(["capability-eval", "--json"]) == 0
    out = capsys.readouterr().out

    # JSON output mode
    payload = json.loads(out)
    assert payload["suite"] == "capabilities"
    assert payload["evaluation_mode"] == "deterministic_component_contracts"
    assert payload["model_invoked"] is False
    assert payload["autonomous_project_validated"] is False
    assert payload["success_rate"] == 1.0
    assert payload["passed"] == 26
    assert "g6-resume-artifacts" in str(out)
    assert "pr1-thinking-tool-choice" in str(out)
    assert "ci1-quality-workflow" in str(out)
    assert "ob1-telemetry-isolation" in str(out)
    assert "sc8-post-edit-consistency" in str(out)
