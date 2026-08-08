"""Evidence-gated Cognitive Runtime promotion into Memory OS candidates."""

from __future__ import annotations

import json

import pytest


def _promotion_journal(
    tmp_path,
    *,
    terminal: bool = True,
    passed: bool = True,
    signal_count: int = 1,
):
    from arforge.core.cognitive_ir import AgentTaskIR, Evidence, LearningSignal, Verification
    from arforge.core.run_event_journal import RunEventJournal

    evidence = Evidence(
        record_id="evidence-1",
        summary="Repository test confirmed the workflow",
        source="pytest:test_workflow",
        authority=0.9,
    )
    verification = Verification(
        record_id="verification-1",
        criterion="Workflow regression test passes",
        verifier="pytest",
        evidence_ids=(evidence.record_id,),
        status="passed" if passed else "failed",
    )
    signal = LearningSignal(
        record_id="learning-1",
        signal_type="workflow",
        outcome="Run the targeted regression test before the full suite",
        reward=0.8,
        evidence_ids=(evidence.record_id,),
    )
    task = AgentTaskIR.create("Repair workflow", task_id="task-promotion")
    records = [evidence, verification, signal]
    if signal_count == 2:
        second_evidence = Evidence(
            record_id="evidence-2",
            summary="A second repository test confirmed the convention",
            source="pytest:test_convention",
            authority=0.8,
        )
        records.extend(
            [
                second_evidence,
                Verification(
                    record_id="verification-2",
                    criterion="Convention regression test passes",
                    verifier="pytest",
                    evidence_ids=(second_evidence.record_id,),
                    status="passed",
                ),
                LearningSignal(
                    record_id="learning-2",
                    signal_type="convention",
                    outcome="Keep promotion writes atomic",
                    reward=0.7,
                    evidence_ids=(second_evidence.record_id,),
                ),
            ]
        )
    for record in records:
        task = task.with_record(record)
    journal = RunEventJournal(tmp_path / "events.jsonl", run_id="run-promotion")
    journal.append("task.created", {"task": task.to_dict()})
    if terminal:
        states = (
            ("created", "understanding"),
            ("understanding", "planning"),
            ("planning", "executing"),
            ("executing", "verifying"),
            ("verifying", "learning"),
            ("learning", "completed"),
        )
        for current, target in states:
            journal.append(
                "state.transitioned",
                {"from": current, "to": target, "lifecycle_mode": "governed"},
            )
    return journal


def test_verified_terminal_journal_produces_candidate_with_bounded_provenance(tmp_path):
    from arforge.memory_os import MemoryOS

    journal = _promotion_journal(tmp_path)

    candidates = MemoryOS().promote_from_journal(
        journal,
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate["lifecycle"] == "candidate"
    assert candidate["memory_class"] == "procedural"
    assert candidate["content"] == "Run the targeted regression test before the full suite"
    assert candidate["provenance"] == {
        "kind": "cognitive_promotion",
        "source_run_id": "run-promotion",
        "source_event_sequence": 6,
        "source_event_checksum": journal.last_position().checksum,
        "task_id": "task-promotion",
        "signal_record_id": "learning-1",
        "verification_record_ids": ["verification-1"],
        "evidence_ids": ["evidence-1"],
    }
    assert "Repository test confirmed" not in json.dumps(candidate["provenance"])


@pytest.mark.parametrize(
    ("terminal", "passed", "match"),
    [
        (False, True, "terminal"),
        (True, False, "passed verification"),
    ],
)
def test_nonterminal_or_unverified_journal_creates_no_candidate(
    tmp_path, terminal, passed, match
):
    from arforge.database import Memory, get_session
    from arforge.memory_os import MemoryOS, MemoryPromotionError

    journal = _promotion_journal(tmp_path, terminal=terminal, passed=passed)

    with pytest.raises(MemoryPromotionError, match=match):
        MemoryOS().promote_from_journal(
            journal,
            project_id="workspace:abc",
            workspace_path="E:/repo",
        )

    with get_session() as session:
        assert session.query(Memory).count() == 0


def test_corrupt_journal_creates_no_candidate(tmp_path):
    from arforge.core.run_event_journal import JournalIntegrityError
    from arforge.database import Memory, get_session
    from arforge.memory_os import MemoryOS

    journal = _promotion_journal(tmp_path)
    lines = journal.path.read_text(encoding="utf-8").splitlines()
    payload = json.loads(lines[-1])
    payload["payload"]["to"] = "failed"
    lines[-1] = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    journal.path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(JournalIntegrityError):
        MemoryOS().promote_from_journal(
            journal,
            project_id="workspace:abc",
            workspace_path="E:/repo",
        )
    with get_session() as session:
        assert session.query(Memory).count() == 0


def test_multiple_promotion_candidates_commit_atomically(tmp_path, monkeypatch):
    from arforge.database import Memory, MemoryRevision, get_session
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    append_revision = memory_os._append_revision
    calls = 0

    def fail_second_revision(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("simulated second candidate failure")
        return append_revision(*args, **kwargs)

    monkeypatch.setattr(memory_os, "_append_revision", fail_second_revision)

    with pytest.raises(RuntimeError, match="second candidate failure"):
        memory_os.promote_from_journal(
            _promotion_journal(tmp_path, signal_count=2),
            project_id="workspace:abc",
            workspace_path="E:/repo",
        )

    with get_session() as session:
        assert session.query(Memory).count() == 0
        assert session.query(MemoryRevision).count() == 0


def test_candidate_requires_explicit_activation_or_rejection(tmp_path):
    from arforge.memory import query_memories_for_scope
    from arforge.core.learning_memory_bridge import promote_memories_to_patterns
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    first = memory_os.promote_from_journal(
        _promotion_journal(tmp_path / "accepted"),
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )[0]
    assert query_memories_for_scope(
        project_id="workspace:abc", workspace_path="E:/repo"
    ) == []

    active = memory_os.activate_candidate(
        first["id"],
        expected_version=1,
        actor="user",
        reason="reviewed and accepted",
    )
    assert active["lifecycle"] == "active"
    assert [item["id"] for item in query_memories_for_scope(
        project_id="workspace:abc", workspace_path="E:/repo"
    )] == [active["id"]]

    second = memory_os.promote_from_journal(
        _promotion_journal(tmp_path / "rejected"),
        project_id="workspace:other",
        workspace_path="E:/other",
    )[0]
    second = memory_os.update(
        second["id"],
        expected_version=second["version"],
        review_level=2,
        actor="user",
        reason="reviewed before rejection",
    )
    rejected = memory_os.reject_candidate(
        second["id"],
        expected_version=second["version"],
        actor="user",
        reason="too task-specific",
    )
    assert rejected["lifecycle"] == "rejected"
    assert promote_memories_to_patterns()["promoted"] == 0
    assert [entry["operation"] for entry in memory_os.history(second["id"])] == [
        "promotion_candidate",
        "update",
        "reject",
    ]


def test_learning_bridge_skips_candidate_and_records_active_source_provenance():
    from arforge.core.learning_memory_bridge import promote_memories_to_patterns
    from arforge.database import LearningPattern, get_session
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    candidate = memory_os.create(
        "Run targeted tests first",
        mem_type="workflow",
        lifecycle="candidate",
        importance=4,
        source="runtime",
        actor="runtime:cognitive-promotion",
    )
    candidate = memory_os.update(
        candidate["id"],
        expected_version=1,
        review_level=2,
        actor="user",
        reason="reviewed but not activated",
    )

    assert promote_memories_to_patterns()["promoted"] == 0

    active = memory_os.activate_candidate(
        candidate["id"],
        expected_version=candidate["version"],
        actor="user",
        reason="activate",
    )
    assert promote_memories_to_patterns()["promoted"] == 1
    with get_session() as session:
        pattern = session.query(LearningPattern).one()
        assert pattern.provenance == {
            "kind": "memory_promotion",
            "memory_id": active["id"],
            "memory_uid": active["memory_uid"],
            "memory_version": active["version"],
        }
