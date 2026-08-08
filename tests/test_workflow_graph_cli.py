"""CLI workflow graph execution (the Python runtime stays the CLI authority)."""

from __future__ import annotations

import json


def test_cli_executes_graph_until_approval_and_can_continue_it(monkeypatch, tmp_path, capsys):
    from arforge.cli import main
    from arforge.workflow_graph_runtime import get_workflow_graph_runtime

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    workflow = tmp_path / ".arforge" / "workflows" / "approval.json"
    workflow.parent.mkdir(parents=True)
    workflow.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "name": "cli_approval",
                "steps": [
                    {"id": "gate", "title": "Gate", "kind": "approval"},
                    {
                        "id": "done",
                        "title": "Done",
                        "kind": "checkpoint",
                        "depends_on": ["gate"],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    assert main([
        "workflows",
        "run",
        ".arforge/workflows/approval.json",
        "--execute",
        "--json",
    ]) == 3
    started = json.loads(capsys.readouterr().out)
    assert started["graph_status"] == "waiting_approval"

    assert main([
        "workflows",
        "approve",
        started["graph_run_id"],
        "gate",
        "reviewed",
        "--json",
    ]) == 0
    capsys.readouterr()
    runtime = get_workflow_graph_runtime()
    assert runtime.wait(started["graph_run_id"], 2)["status"] == "completed"
