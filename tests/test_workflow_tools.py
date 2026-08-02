"""Read-only workflow tool registration contracts."""

from __future__ import annotations

import json


def test_workflow_tools_only_discover_and_preview(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    workflow_path = tmp_path / ".arforge" / "workflows" / "review.json"
    workflow_path.parent.mkdir(parents=True)
    workflow_path.write_text(
        json.dumps({"name": "review", "steps": [{"id": "inspect", "prompt": "Inspect."}]}),
        encoding="utf-8",
    )

    from arforge.tools.workflow_tools import list_workflows, preview_project_workflow

    listed = json.loads(list_workflows())
    preview = json.loads(preview_project_workflow(".arforge/workflows/review.json"))

    assert listed == {"count": 1, "items": [".arforge/workflows/review.json"]}
    assert preview["dry_run"] is True
    assert preview["steps"][0]["status"] == "planned"
