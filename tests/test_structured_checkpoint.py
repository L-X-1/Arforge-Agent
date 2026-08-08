"""Semantic recovery and legacy compatibility contracts for V2 checkpoints."""

from __future__ import annotations

import json

import pytest


def _journaled_task(tmp_path, *, run_id="run-checkpoint", task_id="task-checkpoint"):
    from arforge.core.cognitive_ir import AgentTaskIR, Hypothesis
    from arforge.core.cognitive_runtime import replay_cognitive_events
    from arforge.core.run_event_journal import RunEventJournal

    initial = AgentTaskIR.create(
        "Repair cache",
        task_id=task_id,
        created_at="2026-08-03T00:00:00Z",
    )
    hypothesis = Hypothesis(
        record_id="hypothesis-1",
        statement="Normalization is missing",
        confidence=0.7,
        created_at="2026-08-03T00:00:01Z",
    )
    journal = RunEventJournal(tmp_path / run_id / "events.jsonl", run_id=run_id)
    journal.append("task.created", {"task": initial.to_dict()}, timestamp="2026-08-03T00:00:00Z")
    journal.append(
        "record.upserted",
        {"record": hypothesis.to_dict()},
        timestamp="2026-08-03T00:00:01Z",
    )
    return journal, replay_cognitive_events(journal.read_verified())


def test_semantic_checkpoint_round_trip_restores_recovery_state(tmp_path):
    from arforge.core.structured_checkpoint import StructuredCheckpointStore

    journal, task = _journaled_task(tmp_path)
    store = StructuredCheckpointStore(tmp_path, run_id="run-checkpoint")

    saved = store.save(
        task,
        journal,
        completed=("Located CacheResolver",),
        unresolved=("Linux path behavior",),
        next_actions=("Run Linux-path target test",),
        files_touched=("src/cache/resolver.py",),
        budget={"tokens_used": 1200, "steps_taken": 4},
        rollback_point="snapshot-af-19",
        messages=(),
        created_at="2026-08-03T00:00:02Z",
    )
    loaded = store.load_latest(journal)

    assert loaded.checkpoint == saved
    assert loaded.checkpoint.task == task
    assert loaded.checkpoint.completed == ("Located CacheResolver",)
    assert loaded.checkpoint.unresolved == ("Linux path behavior",)
    assert loaded.checkpoint.next_actions == ("Run Linux-path target test",)
    assert loaded.checkpoint.files_touched == ("src/cache/resolver.py",)
    assert loaded.checkpoint.budget == {"tokens_used": 1200, "steps_taken": 4}
    assert loaded.checkpoint.rollback_point == "snapshot-af-19"
    assert loaded.checkpoint.messages == ()
    assert loaded.checkpoint.event_sequence == 1
    assert loaded.fallback_used is False
    assert loaded.warnings == ()


def test_store_retains_only_configured_number_of_atomic_versions(tmp_path):
    from arforge.core.structured_checkpoint import StructuredCheckpointStore

    journal, task = _journaled_task(tmp_path, run_id="run-retention", task_id="task-retention")
    store = StructuredCheckpointStore(tmp_path, run_id="run-retention", retention=2)
    saved = []
    for index in range(3):
        journal.append("com.example.progress", {"index": index})
        saved.append(store.save(task, journal, created_at=f"2026-08-03T00:00:0{index + 2}Z"))

    files = store.list_versions()
    assert len(files) == 2
    assert not any(path.name.endswith(".tmp") for path in store.checkpoint_dir.iterdir())
    assert store.load_latest(journal).checkpoint.checkpoint_id == saved[-1].checkpoint_id


def test_corrupt_latest_checkpoint_falls_back_to_prior_valid_version(tmp_path):
    from arforge.core.structured_checkpoint import StructuredCheckpointStore

    journal, task = _journaled_task(tmp_path, run_id="run-fallback", task_id="task-fallback")
    store = StructuredCheckpointStore(tmp_path, run_id="run-fallback", retention=3)
    first = store.save(task, journal, completed=("first",), created_at="2026-08-03T00:00:02Z")
    journal.append("com.example.progress", {"stage": 2})
    second = store.save(task, journal, completed=("second",), created_at="2026-08-03T00:00:03Z")
    latest_path = next(path for path in store.list_versions() if second.checkpoint_id in path.name)
    payload = json.loads(latest_path.read_text(encoding="utf-8"))
    payload["completed"] = ["tampered"]
    latest_path.write_text(json.dumps(payload), encoding="utf-8")

    loaded = store.load_latest(journal)

    assert loaded.checkpoint.checkpoint_id == first.checkpoint_id
    assert loaded.fallback_used is True
    assert loaded.warnings
    assert second.checkpoint_id in loaded.warnings[0]
    assert "digest" in loaded.warnings[0]


def test_checkpoint_pointing_beyond_verified_journal_is_rejected(tmp_path):
    from arforge.core.structured_checkpoint import (
        CheckpointConsistencyError,
        StructuredCheckpointStore,
    )

    journal, task = _journaled_task(tmp_path, run_id="run-mismatch", task_id="task-mismatch")
    store = StructuredCheckpointStore(tmp_path, run_id="run-mismatch")
    store.save(task, journal)
    journal.path.write_bytes(b"")

    with pytest.raises(CheckpointConsistencyError, match=r"sequence 1.*journal ends at -1"):
        store.load_latest(journal)


def test_legacy_message_checkpoint_migration_never_invents_semantics():
    from arforge.core.structured_checkpoint import migrate_legacy_checkpoint

    legacy = {
        "run_id": "run-legacy",
        "task": "Repair cache",
        "messages": [
            {"role": "user", "content": "Repair cache"},
            {"role": "assistant", "content": "Maybe normalization is missing"},
        ],
        "status": "paused",
        "steps_completed": 3,
        "tokens_used": 700,
    }

    migrated = migrate_legacy_checkpoint(legacy)

    assert migrated.run_id == "run-legacy"
    assert migrated.objective == "Repair cache"
    assert migrated.messages == tuple(legacy["messages"])
    assert migrated.status == "paused"
    assert migrated.semantic_state_available is False
    assert migrated.agent_ir is None
    assert "No beliefs, hypotheses, decisions, or verification records were inferred" in migrated.warning


def test_checkpoint_digest_validation_rejects_unknown_schema(tmp_path):
    from arforge.core.structured_checkpoint import CheckpointIntegrityError, StructuredCheckpoint

    journal, task = _journaled_task(tmp_path, run_id="run-schema", task_id="task-schema")
    payload = {
        "schema_version": "999",
        "checkpoint_id": "checkpoint-schema",
        "run_id": "run-schema",
        "created_at": "2026-08-03T00:00:02Z",
        "event_sequence": journal.last_position().sequence,
        "event_checksum": journal.last_position().checksum,
        "task": task.to_dict(),
        "completed": [],
        "unresolved": [],
        "next_actions": [],
        "files_touched": [],
        "budget": {},
        "rollback_point": "",
        "messages": [],
        "extensions": {},
        "digest": "sha256:" + "0" * 64,
    }

    with pytest.raises(CheckpointIntegrityError, match="schema_version"):
        StructuredCheckpoint.from_dict(payload)
