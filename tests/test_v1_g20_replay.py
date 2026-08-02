"""G20 trace 落盘 + replay 诊断入口测试。"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))
    yield


def test_replay_renders_trace_messages_and_transaction(capsys):
    from arforge.cli import _run_replay
    from arforge.core.run_transaction import (
        get_run_transaction,
        persist_run_transaction,
        save_run_messages,
        save_run_trace,
    )

    run_id = "20260101-010101"
    save_run_messages(run_id, [{"role": "user", "content": "do it"}])
    save_run_trace(
        run_id,
        [
            {"step": 1, "event": "tool", "tool": "write_file", "success": True},
            {"step": 2, "event": "self_correct_feedback", "tool": "run_cmd"},
            {"step": 2, "event": "max_steps_reached"},
        ],
        {"summary": {"llm_calls": 2, "tool_calls": 1, "total_tokens": 123, "cost_cny": 0.004}},
        "final answer",
        {"total_failures": 1, "events": {"feedback": 1, "repeat_blocked": 0, "reflections": 0, "abort_injected": 0}},
    )
    get_run_transaction().snapshot("/tmp/a.py", None)
    persist_run_transaction(run_id)

    assert _run_replay([run_id]) == 0
    out = capsys.readouterr().out
    assert f"Replay {run_id}" in out
    assert "Messages" in out
    assert "Tool timeline" in out
    assert "write_file" in out
    assert "Failure signals" in out
    assert "max_steps_reached" in out
    assert "Self-correction" in out
    assert "Feedback prompts" in out
    assert "run_cmd" in out
    assert "final answer" in out


def test_replay_defaults_to_latest_replayable_run(capsys):
    from arforge.cli import _run_replay
    from arforge.core.run_transaction import save_run_trace

    save_run_trace("20260101-000001", [], {}, "old")
    save_run_trace("20260101-000002", [], {}, "new")

    assert _run_replay([]) == 0
    assert "Replay 20260101-000002" in capsys.readouterr().out


def test_replay_reports_missing_runs(capsys):
    from arforge.cli import _run_replay

    assert _run_replay([]) == 1
    assert "No replayable agentic runs found" in capsys.readouterr().out
