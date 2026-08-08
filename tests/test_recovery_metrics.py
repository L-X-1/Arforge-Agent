"""任务状态恢复准确率指标管道测试。"""

from __future__ import annotations

import hashlib
import json
import os

from arforge.core.recovery_metrics import (
    clear_recovery_metrics,
    record_recovery_outcome,
    recovery_accuracy_report,
)


def _outcomes_file() -> str:
    return os.path.join(os.environ["ARFORGE_HOME"], "recovery_outcomes.jsonl")


def _read_outcomes() -> list[dict]:
    path = _outcomes_file()
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def test_record_appends_anonymized_jsonl():
    record_recovery_outcome(
        session_id="session-secret-abc",
        recovery_state="verified_checkpoint",
        verified=True,
        workspace_path=r"E:\confidential-repo",
        duration_ms=12.5,
        note="digest matched",
    )

    entries = _read_outcomes()
    assert len(entries) == 1
    entry = entries[0]
    assert entry["ts"].endswith("Z")
    assert (
        entry["session_hash"]
        == hashlib.sha256(b"session-secret-abc").hexdigest()[:24]
    )
    assert entry["recovery_state"] == "verified_checkpoint"
    assert entry["verified"] is True
    assert entry["workspace_scope"] == hashlib.sha256(
        r"E:\confidential-repo".encode("utf-8")
    ).hexdigest()[:16]
    assert entry["duration_ms"] == 12.5
    assert entry["note"] == "digest matched"

    with open(_outcomes_file(), encoding="utf-8") as f:
        content = f.read()
    assert "session-secret-abc" not in content
    assert "confidential-repo" not in content


def test_record_truncates_note_and_skips_workspace_scope_when_empty():
    record_recovery_outcome(
        session_id="s-1",
        recovery_state="transcript_rebuild_pending",
        verified=False,
        note="x" * 500,
    )

    entry = _read_outcomes()[0]
    assert len(entry["note"]) == 200
    assert entry["workspace_scope"] == ""
    assert entry["verified"] is False


def test_report_aggregates_states_rates_and_daily_trend():
    clear_recovery_metrics()
    record_recovery_outcome(
        session_id="a", recovery_state="verified_checkpoint", verified=True
    )
    record_recovery_outcome(
        session_id="b", recovery_state="rebuild_pending_stale", verified=False
    )
    record_recovery_outcome(
        session_id="c", recovery_state="rebuild_pending_missing", verified=False
    )
    record_recovery_outcome(
        session_id="d", recovery_state="transcript_rebuild_pending", verified=False
    )

    report = recovery_accuracy_report()
    assert report["events_total"] == 4
    assert report["verified_count"] == 1
    assert report["restore_success_rate"] == 0.25
    assert report["pending_rebuild_rate"] == 0.75
    assert report["corrupt_rows"] == 0
    assert report["states"] == {
        "rebuild_pending_missing": {"count": 1, "ratio": 0.25},
        "rebuild_pending_stale": {"count": 1, "ratio": 0.25},
        "transcript_rebuild_pending": {"count": 1, "ratio": 0.25},
        "verified_checkpoint": {"count": 1, "ratio": 0.25},
    }
    assert len(report["daily_trend"]) == 7
    assert report["daily_trend"][-1]["total"] == 4
    assert report["daily_trend"][-1]["verified"] == 1
    assert report["daily_trend"][-1]["rate"] == 0.25
    assert all(day["total"] == 0 for day in report["daily_trend"][:-1])


def test_report_skips_corrupt_rows_and_missing_file():
    os.makedirs(os.environ["ARFORGE_HOME"], exist_ok=True)
    with open(_outcomes_file(), "w", encoding="utf-8") as f:
        f.write(
            '{"ts": "2026-08-04T10:00:00.000Z", '
            '"recovery_state": "verified_checkpoint", "verified": true}\n'
        )
        f.write("this is not json\n")
        f.write('{"recovery_state": }\n')

    report = recovery_accuracy_report()
    assert report["events_total"] == 1
    assert report["verified_count"] == 1
    assert report["corrupt_rows"] == 2
    assert report["states"]["verified_checkpoint"]["count"] == 1

    os.remove(_outcomes_file())
    empty = recovery_accuracy_report()
    assert empty["events_total"] == 0
    assert empty["verified_count"] == 0
    assert empty["restore_success_rate"] == 0.0
    assert empty["pending_rebuild_rate"] == 0.0
    assert empty["corrupt_rows"] == 0
    assert len(empty["daily_trend"]) == 7
    assert all(day["total"] == 0 and day["verified"] == 0 for day in empty["daily_trend"])


def test_clear_recovery_metrics_removes_file_and_returns_line_count():
    clear_recovery_metrics()
    record_recovery_outcome(
        session_id="x", recovery_state="verified_checkpoint", verified=True
    )
    record_recovery_outcome(
        session_id="y", recovery_state="transcript_rebuild_pending", verified=False
    )

    assert clear_recovery_metrics() == 2
    assert not os.path.exists(_outcomes_file())
    assert clear_recovery_metrics() == 0


def test_restore_records_verified_checkpoint_outcome():
    from arforge.core.context_os import context_messages_digest
    from arforge.product.session_runtime import SessionRecord, SessionRuntime

    checkpoint = [{"role": "assistant", "content": "【历史摘要】previous work"}]
    session = SessionRecord(
        session_id="session-verified",
        created_at="now",
        updated_at="now",
        context_checkpoint=checkpoint,
        context_status={
            "schema_version": 3,
            "context_package_messages_digest": context_messages_digest(checkpoint),
        },
    )
    agent = object()

    SessionRuntime._restore_agent_context_state(session, agent, [])

    entries = _read_outcomes()
    assert len(entries) == 1
    assert entries[0]["recovery_state"] == "verified_checkpoint"
    assert entries[0]["verified"] is True
    with open(_outcomes_file(), encoding="utf-8") as f:
        assert "session-verified" not in f.read()


def test_restore_records_transcript_rebuild_outcome():
    from arforge.product.session_runtime import SessionRecord, SessionRuntime

    session = SessionRecord(
        session_id="session-transcript",
        created_at="now",
        updated_at="now",
        context_checkpoint=[],
        context_status={},
    )
    agent = object()

    SessionRuntime._restore_agent_context_state(session, agent, [])

    entries = _read_outcomes()
    assert len(entries) == 1
    assert entries[0]["recovery_state"] == "transcript_rebuild_pending"
    assert entries[0]["verified"] is False
