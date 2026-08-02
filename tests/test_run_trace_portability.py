from __future__ import annotations

import json

from arforge.bridge import dispatch
from arforge.core.run_transaction import (
    MAX_REPORT_TRACE_EVENTS,
    build_run_report,
    export_run_trace,
    import_run_trace,
    list_replay_run_ids,
    save_run_trace,
)


def test_trace_export_import_round_trip_is_isolated_and_redacted(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    source_run_id = "source-run"
    save_run_trace(
        source_run_id,
        [
            {
                "event": "tool_result",
                "tool": "run_cmd",
                "command": "pytest -q",
                "returncode": 0,
                "success": True,
                "api_key": "must-not-leak",
            },
            {"event": "answer", "text": "done"},
        ],
        observability={"latency_ms": 12},
        answer="done",
        self_correct={"attempts": 1},
    )

    exported = export_run_trace(source_run_id)
    assert exported["filename"] == "run-trace-source-run.json"
    assert exported["trace_events"] == 2
    assert "must-not-leak" not in exported["content"]
    assert "[REDACTED_SECRET]" in exported["content"]

    imported = import_run_trace(exported["content"])
    assert imported["imported"] is True
    assert imported["source_run_id"] == source_run_id
    assert imported["run_id"].startswith("imported-")
    assert imported["run_id"] != source_run_id

    report = build_run_report(imported["run_id"])
    assert report["has_transaction"] is False
    assert report["has_trace"] is True
    assert report["trace_events"] == 2
    assert report["answer"] == "done"
    assert report["self_correct"] == {"attempts": 1}
    assert report["trace"][0]["tool"] == "run_cmd"


def test_bridge_exposes_trace_portability_with_strict_params(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    save_run_trace("bridge-run", [{"event": "answer", "text": "ok"}], answer="ok")

    described = dispatch({"id": 1, "version": "1.2", "method": "protocol.describe"})
    exported = dispatch(
        {
            "id": 2,
            "version": "1.2",
            "method": "run.trace.export",
            "params": {"run_id": "bridge-run"},
        }
    )
    imported = dispatch(
        {
            "id": 3,
            "version": "1.2",
            "method": "run.trace.import",
            "params": {"content": exported["data"]["content"]},
        }
    )
    rejected = dispatch(
        {
            "id": 4,
            "version": "1.2",
            "method": "run.trace.import",
            "params": {"content": exported["data"]["content"], "unexpected": True},
        }
    )

    assert "run.trace.export" in described["data"]["methods"]
    assert "run.trace.import" in described["data"]["methods"]
    assert "run.trace.export" not in described["data"]["mutating_methods"]
    assert "run.trace.import" in described["data"]["mutating_methods"]
    assert exported["ok"] is True
    assert imported["ok"] is True
    assert imported["data"]["trace_events"] == 1
    assert rejected["error"]["code"] == "INVALID_PARAMS"


def test_trace_import_rejects_untrusted_shapes_without_persisting(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    before = list_replay_run_ids()
    invalid = json.dumps(
        {
            "schema": "arforge.run.trace",
            "schema_version": 1,
            "run_id": "external",
            "trace": [{"event": "answer"}],
            "execute": True,
        }
    )

    try:
        import_run_trace(invalid)
    except ValueError as error:
        assert "unsupported top-level fields" in str(error)
    else:
        raise AssertionError("invalid portable trace must be rejected")

    assert list_replay_run_ids() == before


def test_trace_export_rejects_path_like_run_identifiers(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))

    response = dispatch(
        {
            "id": 5,
            "version": "1.2",
            "method": "run.trace.export",
            "params": {"run_id": "../outside"},
        }
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "INVALID_PARAMS"


def test_run_report_trace_is_bounded(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    save_run_trace(
        "large-run",
        [{"event": "step", "index": index} for index in range(MAX_REPORT_TRACE_EVENTS + 10)],
    )

    report = build_run_report("large-run")

    assert report["trace_events"] == MAX_REPORT_TRACE_EVENTS + 10
    assert len(report["trace"]) == MAX_REPORT_TRACE_EVENTS
    assert report["trace_truncated"] is True
