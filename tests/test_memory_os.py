"""Governed Memory OS domain and immutable revision contracts."""

from __future__ import annotations

import pytest


def test_create_assigns_governed_identity_provenance_and_initial_revision():
    from arforge.memory_os import MemoryOS

    memory = MemoryOS().create(
        "Always use pytest for unit tests",
        mem_type="preference",
        project_id="workspace:abc",
        workspace_path="E:/repo",
        provenance={"kind": "user_statement", "source_id": "turn-7"},
        actor="user:local",
        reason="explicit durable preference",
    )
    history = MemoryOS().history(memory["id"])

    assert isinstance(memory["id"], int)
    assert len(memory["memory_uid"]) == 32
    assert memory["memory_class"] == "user"
    assert memory["lifecycle"] == "active"
    assert memory["confidence"] == 1.0
    assert memory["version"] == 1
    assert memory["content_digest"].startswith("sha256:")
    assert memory["provenance"]["source_id"] == "turn-7"
    assert len(history) == 1
    assert history[0]["operation"] == "create"
    assert history[0]["snapshot"]["content"] == memory["content"]
    assert history[0]["previous_revision_digest"] == ""


@pytest.mark.parametrize(
    ("overrides", "match"),
    [
        ({"memory_class": "dream"}, "memory_class"),
        ({"lifecycle": "immortal"}, "lifecycle"),
        ({"confidence": 1.1}, "confidence"),
        ({"provenance": ["not", "an", "object"]}, "provenance"),
    ],
)
def test_invalid_governed_create_is_atomic(overrides, match):
    from arforge.database import Memory, MemoryRevision, get_session
    from arforge.memory_os import MemoryOS, MemoryValidationError

    with pytest.raises(MemoryValidationError, match=match):
        MemoryOS().create("durable fact", **overrides)

    with get_session() as session:
        assert session.query(Memory).count() == 0
        assert session.query(MemoryRevision).count() == 0


def test_update_appends_verifiable_hash_chained_revision():
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    created = memory_os.create("Use unittest", mem_type="preference")
    updated = memory_os.update(
        created["id"],
        expected_version=1,
        content="Use pytest",
        importance=4,
        actor="user:local",
        reason="user corrected framework",
    )
    report = memory_os.verify_history(created["id"])
    history = memory_os.history(created["id"])

    assert updated["version"] == 2
    assert updated["content"] == "Use pytest"
    assert history[1]["previous_revision_digest"] == history[0]["revision_digest"]
    assert report == {
        "memory_id": created["id"],
        "memory_uid": created["memory_uid"],
        "versions": 2,
        "valid": True,
        "current_version": 2,
    }


def test_stale_expected_version_cannot_overwrite_or_append():
    from arforge.memory_os import MemoryConflictError, MemoryOS

    memory_os = MemoryOS()
    created = memory_os.create("Use pytest", mem_type="preference")
    memory_os.update(created["id"], expected_version=1, importance=4)

    with pytest.raises(MemoryConflictError, match=r"expected version 1.*actual 2"):
        memory_os.update(created["id"], expected_version=1, content="Use nose")

    assert memory_os.get(created["id"])["content"] == "Use pytest"
    assert memory_os.get(created["id"])["version"] == 2
    assert len(memory_os.history(created["id"])) == 2


def test_revision_failure_rolls_back_current_projection(monkeypatch):
    from arforge.database import Memory, MemoryRevision, get_session
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    monkeypatch.setattr(
        memory_os,
        "_append_revision",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("ledger unavailable")),
    )

    with pytest.raises(RuntimeError, match="ledger unavailable"):
        memory_os.create("Never partially persist this")

    with get_session() as session:
        assert session.query(Memory).count() == 0
        assert session.query(MemoryRevision).count() == 0


def test_history_verifier_reports_first_tampered_revision():
    from arforge.database import MemoryRevision, get_session
    from arforge.memory_os import MemoryIntegrityError, MemoryOS

    memory_os = MemoryOS()
    created = memory_os.create("Use pytest")
    memory_os.update(created["id"], expected_version=1, importance=3)
    with get_session() as session:
        revision = (
            session.query(MemoryRevision)
            .filter(MemoryRevision.memory_id == created["id"], MemoryRevision.version == 1)
            .one()
        )
        revision.snapshot = {**revision.snapshot, "content": "tampered"}

    with pytest.raises(MemoryIntegrityError, match=r"version 1.*digest"):
        memory_os.verify_history(created["id"])


def test_legacy_save_and_update_use_the_same_governed_revision_chain():
    from arforge.memory import save_memory_v2, update_memory_fields
    from arforge.memory_os import MemoryOS

    memory_id = save_memory_v2(
        "Always use pytest",
        mem_type="preference",
        source="user",
        importance=3,
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )
    updated = update_memory_fields(
        memory_id,
        content="Always use pytest with strict markers",
        importance=4,
        source="user-corrected",
    )

    assert updated["memory_class"] == "user"
    assert updated["lifecycle"] == "active"
    assert updated["version"] == 2
    history = MemoryOS().history(memory_id)
    assert [revision["operation"] for revision in history] == ["create", "update"]
    assert history[0]["actor"] == "user"
    assert history[1]["actor"] == "user-corrected"


def test_legacy_scoped_query_excludes_explicitly_inactive_lifecycle():
    from arforge.memory import query_memories_for_scope, save_memory_v2
    from arforge.memory_os import MemoryOS

    memory_id = save_memory_v2(
        "Always use pytest",
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )
    MemoryOS().update(
        memory_id,
        expected_version=1,
        lifecycle="forgotten",
        actor="user",
        reason="temporarily hide",
    )

    assert query_memories_for_scope(
        project_id="workspace:abc",
        workspace_path="E:/repo",
    ) == []


def test_domain_type_change_reclassifies_unless_class_is_explicit():
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    created = memory_os.create("A fact", mem_type="fact")

    updated = memory_os.update(
        created["id"],
        expected_version=1,
        mem_type="preference",
        actor="user",
        reason="reclassified",
    )

    assert updated["mem_type"] == "preference"
    assert updated["memory_class"] == "user"
