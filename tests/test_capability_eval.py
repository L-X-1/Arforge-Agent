from __future__ import annotations

import json

from arforge.cli import main
from arforge.core.capability_eval import (
    builtin_capability_eval_tasks,
    format_capability_eval_report,
    report_to_dict,
    run_capability_eval,
    self_correct_eval_tasks,
)


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
