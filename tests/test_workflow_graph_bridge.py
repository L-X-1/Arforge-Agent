"""Bridge integration for durable workflow graph controls."""

from __future__ import annotations

import json
import time


def _request(method, params=None, request_id="req"):
    return {
        "id": request_id,
        "protocol": "arforge.bridge",
        "version": "1.2",
        "method": method,
        "params": params or {},
    }


def _wait_status(service, run_id, expected):
    from arforge.bridge import dispatch

    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = dispatch(
            _request("workflow.graph.get", {"run_id": run_id}),
            service=service,
        )
        if response["ok"] and response["data"]["status"] == expected:
            return response["data"]
        time.sleep(0.01)
    raise AssertionError(f"graph did not reach {expected}")


def test_bridge_lists_starts_approves_and_audits_graph_runs(monkeypatch, tmp_path):
    from arforge.bridge import dispatch
    from arforge.product.service import ProductService

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    workflow = tmp_path / ".arforge" / "workflows" / "approval.json"
    workflow.parent.mkdir(parents=True)
    workflow.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "name": "approval_graph",
                "steps": [
                    {
                        "id": "gate",
                        "title": "Review",
                        "kind": "approval",
                        "prompt": "Confirm the reviewed change.",
                    },
                    {
                        "id": "checkpoint",
                        "title": "Checkpoint",
                        "kind": "checkpoint",
                        "depends_on": ["gate"],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    service = ProductService()

    listed = dispatch(_request("workflows.list"), service=service)
    assert listed["ok"] is True
    assert listed["data"]["items"][0]["has_approval"] is True

    started = dispatch(
        _request(
            "workflow.graph.start",
            {
                "path": ".arforge/workflows/approval.json",
                "session_id": "desktop",
                "max_parallel": 2,
            },
        ),
        service=service,
    )
    assert started["ok"] is True
    run_id = started["data"]["run_id"]
    waiting = _wait_status(service, run_id, "waiting_approval")
    assert waiting["nodes"][0]["status"] == "waiting_approval"

    approved = dispatch(
        _request(
            "workflow.graph.approve",
            {
                "run_id": run_id,
                "node_id": "gate",
                "approved": True,
                "comment": "reviewed",
            },
        ),
        service=service,
    )
    assert approved["ok"] is True
    completed = _wait_status(service, run_id, "completed")
    assert completed["progress"]["percent"] == 100.0

    events = dispatch(
        _request("workflow.graph.events", {"run_id": run_id, "after": 0}),
        service=service,
    )
    assert events["ok"] is True
    assert "node.approved" in {item["type"] for item in events["data"]["items"]}


def test_bridge_advertises_graph_controls_and_rejects_unknown_parameters(tmp_path, monkeypatch):
    from arforge.bridge import dispatch
    from arforge.product.service import ProductService

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    service = ProductService()
    described = dispatch(_request("protocol.describe"), service=service)

    assert "workflow.graph.start" in described["data"]["methods"]
    assert "workflow.graph.start" in described["data"]["workspace_mutating_methods"]
    rejected = dispatch(
        _request("workflow.graph.list", {"unexpected": True}),
        service=service,
    )
    assert rejected["ok"] is False
    assert rejected["error"]["code"] == "INVALID_PARAMS"


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
