"""Integrity, concurrency, and replay contracts for cognitive run events."""

from __future__ import annotations

import json
import os

import pytest


def test_append_assigns_monotonic_sequence_and_hash_chain(tmp_path):
    from arforge.core.run_event_journal import RunEventJournal

    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-chain")
    first = journal.append("task.created", {"objective": "repair"}, expected_last_sequence=-1)
    second = journal.append("state.transitioned", {"from": "created", "to": "planning"}, expected_last_sequence=0)

    assert first.sequence == 0
    assert first.previous_checksum == ""
    assert second.sequence == 1
    assert second.previous_checksum == first.checksum
    assert journal.last_position().sequence == 1
    assert journal.last_position().checksum == second.checksum
    assert journal.read_verified() == (first, second)


def test_stale_expected_sequence_is_rejected_without_partial_append(tmp_path):
    from arforge.core.run_event_journal import JournalConflictError, RunEventJournal

    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-conflict")
    journal.append("task.created", {"objective": "repair"}, expected_last_sequence=-1)

    with pytest.raises(JournalConflictError, match=r"expected last sequence -1.*actual 0"):
        journal.append("state.transitioned", {"to": "planning"}, expected_last_sequence=-1)

    assert len(journal.read_verified()) == 1
    assert (tmp_path / "events.jsonl").read_bytes().endswith(b"\n")


def test_exclusive_writer_lock_blocks_a_second_writer(tmp_path):
    from arforge.core.run_event_journal import JournalLockError, RunEventJournal

    path = tmp_path / "events.jsonl"
    journal = RunEventJournal(path, run_id="run-lock", lock_timeout=0.01)
    journal.lock_path.write_text(
        json.dumps({"pid": os.getpid(), "token": "foreign", "created_epoch": 0}),
        encoding="utf-8",
    )

    with pytest.raises(JournalLockError, match="exclusive writer lock"):
        journal.append("task.created", {"objective": "repair"})
    assert not path.exists()


def test_payload_size_limit_rejects_raw_unbounded_output(tmp_path):
    from arforge.core.run_event_journal import JournalPayloadTooLarge, RunEventJournal

    journal = RunEventJournal(
        tmp_path / "events.jsonl",
        run_id="run-bounds",
        max_payload_bytes=64,
    )

    with pytest.raises(JournalPayloadTooLarge, match="payload"):
        journal.append("tool.observed", {"stdout": "x" * 500})


def test_modified_payload_is_detected_at_exact_sequence(tmp_path):
    from arforge.core.run_event_journal import JournalIntegrityError, RunEventJournal

    path = tmp_path / "events.jsonl"
    journal = RunEventJournal(path, run_id="run-tamper")
    journal.append("task.created", {"objective": "repair"})
    journal.append("state.transitioned", {"from": "created", "to": "planning"})
    lines = path.read_text(encoding="utf-8").splitlines()
    changed = json.loads(lines[1])
    changed["payload"]["to"] = "completed"
    lines[1] = json.dumps(changed, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(JournalIntegrityError, match=r"sequence 1.*checksum"):
        journal.read_verified()


def test_truncated_final_record_is_detected_and_not_projected(tmp_path):
    from arforge.core.run_event_journal import JournalIntegrityError, RunEventJournal

    path = tmp_path / "events.jsonl"
    journal = RunEventJournal(path, run_id="run-truncated")
    journal.append("task.created", {"objective": "repair"})
    path.write_bytes(path.read_bytes()[:-4])

    with pytest.raises(JournalIntegrityError, match=r"truncated.*sequence 0"):
        journal.read_verified()


def test_run_identity_mismatch_is_detected(tmp_path):
    from arforge.core.run_event_journal import JournalIntegrityError, RunEventJournal

    path = tmp_path / "events.jsonl"
    RunEventJournal(path, run_id="run-a").append("task.created", {"objective": "repair"})

    with pytest.raises(JournalIntegrityError, match=r"sequence 0.*run_id"):
        RunEventJournal(path, run_id="run-b").read_verified()


def test_unknown_event_envelope_field_is_rejected_instead_of_left_unsigned(tmp_path):
    from arforge.core.run_event_journal import JournalIntegrityError, RunEventJournal

    path = tmp_path / "events.jsonl"
    journal = RunEventJournal(path, run_id="run-envelope")
    journal.append("task.created", {"objective": "repair"})
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["unsigned_future_field"] = "would bypass the checksum"
    path.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(JournalIntegrityError, match=r"sequence 0.*unknown fields"):
        journal.read_verified()


def test_deterministic_replay_rebuilds_identical_agent_ir(tmp_path):
    from arforge.core.cognitive_ir import AgentTaskIR, Evidence
    from arforge.core.cognitive_runtime import replay_cognitive_events
    from arforge.core.run_event_journal import RunEventJournal

    initial = AgentTaskIR.create("Repair cache", task_id="task-replay", created_at="2026-08-03T00:00:00Z")
    evidence = Evidence(
        record_id="evidence-1",
        summary="Target test failed",
        source="pytest:cache-test",
        created_at="2026-08-03T00:00:01Z",
    )
    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-replay")
    journal.append("task.created", {"task": initial.to_dict()}, timestamp="2026-08-03T00:00:00Z")
    journal.append(
        "state.transitioned",
        {"from": "created", "to": "understanding", "reason": "start"},
        timestamp="2026-08-03T00:00:01Z",
    )
    journal.append(
        "record.upserted",
        {"record": evidence.to_dict()},
        timestamp="2026-08-03T00:00:02Z",
    )
    journal.append(
        "com.example.metric",
        {"latency_ms": 42},
        timestamp="2026-08-03T00:00:03Z",
    )
    events = journal.read_verified()

    first = replay_cognitive_events(events)
    second = replay_cognitive_events(events)

    assert first == second
    assert first.state.value == "understanding"
    assert first.record("evidence-1") == evidence
    assert first.revision == 2


def test_projector_rejects_state_from_mismatch(tmp_path):
    from arforge.core.cognitive_ir import AgentTaskIR, IRValidationError
    from arforge.core.cognitive_runtime import replay_cognitive_events
    from arforge.core.run_event_journal import RunEventJournal

    initial = AgentTaskIR.create("Repair cache", task_id="task-state", created_at="2026-08-03T00:00:00Z")
    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-state")
    journal.append("task.created", {"task": initial.to_dict()})
    journal.append("state.transitioned", {"from": "executing", "to": "completed", "reason": "bad"})

    with pytest.raises(IRValidationError, match=r"events\[1\].payload.from"):
        replay_cognitive_events(journal.read_verified())


def test_projector_rejects_integrity_valid_but_illegal_lifecycle_transition(tmp_path):
    from arforge.core.cognitive_ir import AgentTaskIR, IRValidationError
    from arforge.core.cognitive_runtime import replay_cognitive_events
    from arforge.core.run_event_journal import RunEventJournal

    initial = AgentTaskIR.create("Repair cache", task_id="task-illegal-state")
    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-illegal-state")
    journal.append("task.created", {"task": initial.to_dict()})
    journal.append(
        "state.transitioned",
        {
            "from": "created",
            "to": "completed",
            "reason": "skip all governance",
            "lifecycle_mode": "governed",
        },
    )

    with pytest.raises(IRValidationError, match=r"events\[1\].payload.to.*created -> completed"):
        replay_cognitive_events(journal.read_verified())


def test_projector_applies_record_status_changes_and_ignores_checkpoint_markers(tmp_path):
    from arforge.core.cognitive_ir import Action, AgentTaskIR
    from arforge.core.cognitive_runtime import replay_cognitive_events
    from arforge.core.run_event_journal import RunEventJournal

    initial = AgentTaskIR.create("Repair cache", task_id="task-status")
    action = Action(
        record_id="action-1",
        action_type="plan_step",
        target="Run tests",
        status="pending",
    )
    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-status")
    journal.append("task.created", {"task": initial.to_dict()})
    journal.append("record.upserted", {"record": action.to_dict()})
    journal.append(
        "checkpoint.created",
        {
            "checkpoint_id": "checkpoint-1",
            "event_sequence": 1,
            "event_checksum": journal.last_position().checksum,
        },
    )
    journal.append(
        "record.status_changed",
        {"record_id": "action-1", "from": "pending", "to": "completed"},
    )

    restored = replay_cognitive_events(journal.read_verified())

    assert restored.record("action-1").status == "completed"
    assert restored.revision == 2


def test_projector_validates_known_rollback_audit_event(tmp_path):
    from arforge.core.cognitive_ir import AgentTaskIR
    from arforge.core.cognitive_runtime import replay_cognitive_events
    from arforge.core.run_event_journal import RunEventJournal

    task = AgentTaskIR.create("Repair cache", task_id="task-rollback-event")
    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-rollback-event")
    journal.append("task.created", {"task": task.to_dict()})
    journal.append(
        "state.transitioned",
        {"from": "created", "to": "understanding", "lifecycle_mode": "governed"},
    )
    journal.append(
        "state.transitioned",
        {"from": "understanding", "to": "failed", "lifecycle_mode": "governed"},
    )
    journal.append(
        "state.transitioned",
        {"from": "failed", "to": "rolling_back", "lifecycle_mode": "governed"},
    )
    journal.append(
        "rollback.recorded",
        {
            "source_state": "failed",
            "restored_point": "run:run-rollback-event",
            "status": "succeeded",
        },
    )
    journal.append(
        "state.transitioned",
        {"from": "rolling_back", "to": "rolled_back", "lifecycle_mode": "governed"},
    )

    restored = replay_cognitive_events(journal.read_verified())

    assert restored.state.value == "rolled_back"


def test_projector_rejects_malformed_rollback_audit_event(tmp_path):
    from arforge.core.cognitive_ir import AgentTaskIR, IRValidationError
    from arforge.core.cognitive_runtime import replay_cognitive_events
    from arforge.core.run_event_journal import RunEventJournal

    task = AgentTaskIR.create("Repair cache", task_id="task-bad-rollback-event")
    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-bad-rollback-event")
    journal.append("task.created", {"task": task.to_dict()})
    journal.append("rollback.recorded", {"status": "pretended"})

    with pytest.raises(IRValidationError, match=r"events\[1\].payload"):
        replay_cognitive_events(journal.read_verified())


def test_unknown_safety_critical_event_is_rejected(tmp_path):
    from arforge.core.cognitive_ir import AgentTaskIR, IRValidationError
    from arforge.core.cognitive_runtime import replay_cognitive_events
    from arforge.core.run_event_journal import RunEventJournal

    task = AgentTaskIR.create("Repair cache", task_id="task-critical")
    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-critical")
    journal.append("task.created", {"task": task.to_dict()})
    journal.append("state.force_completed", {"reason": "unknown producer"})

    with pytest.raises(IRValidationError, match="unknown safety-critical event"):
        replay_cognitive_events(journal.read_verified())
