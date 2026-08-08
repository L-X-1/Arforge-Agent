"""Memory correction, relation, lifecycle, and deletion governance."""

from __future__ import annotations

import pytest


def test_correction_atomically_supersedes_original_and_recalls_successor():
    from arforge.memory import query_memories_for_scope
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    original = memory_os.create(
        "The service uses unittest",
        mem_type="fact",
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )
    corrected = memory_os.correct(
        original["id"],
        "The service uses pytest",
        expected_version=1,
        actor="user",
        reason="repository tests prove pytest",
        provenance={"kind": "user_correction", "evidence_ids": ["verification-1"]},
    )

    assert memory_os.get(original["id"])["lifecycle"] == "superseded"
    assert corrected["lifecycle"] == "active"
    assert corrected["provenance"]["corrects_memory_uid"] == original["memory_uid"]
    relations = memory_os.relations(memory_id=original["id"])
    assert len(relations) == 1
    assert relations[0]["relation_type"] == "supersedes"
    assert relations[0]["source_memory_id"] == corrected["id"]
    assert relations[0]["target_memory_id"] == original["id"]
    recalled = query_memories_for_scope(
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )
    assert [item["id"] for item in recalled] == [corrected["id"]]


def test_correction_failure_leaves_original_active(monkeypatch):
    from arforge.database import Memory, MemoryRelation, get_session
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    original = memory_os.create("The service uses unittest")
    monkeypatch.setattr(
        memory_os,
        "_add_relation",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("relation unavailable")),
    )

    with pytest.raises(RuntimeError, match="relation unavailable"):
        memory_os.correct(
            original["id"],
            "The service uses pytest",
            expected_version=1,
            actor="user",
            reason="correction",
        )

    assert memory_os.get(original["id"])["lifecycle"] == "active"
    assert len(memory_os.history(original["id"])) == 1
    with get_session() as session:
        assert session.query(Memory).count() == 1
        assert session.query(MemoryRelation).count() == 0


def test_contradiction_relation_never_changes_memory_state():
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    first = memory_os.create("Use pytest", confidence=0.8)
    second = memory_os.create("Use unittest", confidence=0.7)
    relation = memory_os.relate(
        first["id"],
        second["id"],
        relation_type="contradicts",
        status="proposed",
        confidence=0.6,
        evidence={"evidence_ids": ["evidence-1"]},
        actor="runtime:detector",
        reason="same subject, conflicting values",
    )

    assert relation["status"] == "proposed"
    assert relation["evidence"] == {"evidence_ids": ["evidence-1"]}
    assert memory_os.get(first["id"])["lifecycle"] == "active"
    assert memory_os.get(second["id"])["lifecycle"] == "active"


def test_forget_and_restore_are_reversible_revisioned_operations():
    from arforge.memory import query_memories_for_scope
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    created = memory_os.create(
        "Use pytest",
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )
    forgotten = memory_os.forget(
        created["id"], expected_version=1, actor="user", reason="not relevant now"
    )
    assert forgotten["lifecycle"] == "forgotten"
    assert query_memories_for_scope(
        project_id="workspace:abc", workspace_path="E:/repo"
    ) == []

    restored = memory_os.restore(
        created["id"], expected_version=2, actor="user", reason="relevant again"
    )
    assert restored["lifecycle"] == "active"
    assert [item["id"] for item in query_memories_for_scope(
        project_id="workspace:abc", workspace_path="E:/repo"
    )] == [created["id"]]
    assert [item["operation"] for item in memory_os.history(created["id"])] == [
        "create",
        "forget",
        "restore",
    ]


def test_explicit_delete_removes_history_relations_and_retrieval_references():
    from arforge.database import MemoryRelation, MemoryRetrievalEvent, MemoryRevision, get_session
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    deleted = memory_os.create("Delete me")
    survivor = memory_os.create("Keep me")
    memory_os.relate(
        deleted["id"],
        survivor["id"],
        relation_type="supports",
        actor="user",
        reason="linked",
    )
    with get_session() as session:
        session.add(
            MemoryRetrievalEvent(
                retrieval_uid="retrieval-delete",
                created_at="2026-08-03T00:00:00Z",
                scope_id="workspace:abc",
                query_fingerprint="sha256:private",
                algorithm="bm25",
                algorithm_version="1",
                candidate_count=2,
                returned=[
                    {"memory_id": deleted["id"], "score": 0.9},
                    {"memory_id": survivor["id"], "score": 0.8},
                ],
                feedback={"useful_memory_ids": [deleted["id"], survivor["id"]]},
            )
        )

    report = memory_os.delete(deleted["id"], actor="user", reason="privacy request")

    assert report["deleted"] is True
    with get_session() as session:
        assert session.query(MemoryRevision).filter_by(memory_id=deleted["id"]).count() == 0
        assert session.query(MemoryRelation).count() == 0
        retrieval = session.query(MemoryRetrievalEvent).one()
        assert retrieval.returned == [{"memory_id": survivor["id"], "score": 0.8}]
        assert retrieval.feedback == {"useful_memory_ids": [survivor["id"]]}
    assert memory_os.get(survivor["id"])["content"] == "Keep me"


def test_compatibility_delete_uses_complete_memory_os_cleanup():
    from arforge.database import MemoryRevision, get_session
    from arforge.memory import delete_memory, save_memory_v2

    memory_id = save_memory_v2("Delete through legacy API")

    assert delete_memory(memory_id) is True
    assert delete_memory(memory_id) is False
    with get_session() as session:
        assert session.query(MemoryRevision).filter_by(memory_id=memory_id).count() == 0


def test_decay_is_revisioned_and_never_weakens_explicit_user_memory():
    from arforge.memory import decay_memory_strength, save_memory_v2
    from arforge.memory_os import MemoryOS

    auto_id = save_memory_v2("Automatically learned", source="auto")
    user_id = save_memory_v2("Explicit user fact", source="user")

    report = decay_memory_strength()

    assert report == {"success": True, "updated": 1, "dry_run": False}
    assert MemoryOS().get(auto_id)["strength"] == pytest.approx(0.99)
    assert MemoryOS().get(user_id)["strength"] == 1.0
    assert [item["operation"] for item in MemoryOS().history(auto_id)] == ["create", "decay"]
