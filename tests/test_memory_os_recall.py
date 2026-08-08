"""Measured, scoped, privacy-minimized Memory OS recall."""

from __future__ import annotations


def test_recall_ranks_only_active_authorized_memories_with_score_provenance():
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    active = memory_os.create(
        "Use pytest for unit tests",
        mem_type="preference",
        project_id="workspace:abc",
        workspace_path="E:/repo",
        importance=4,
    )
    forgotten = memory_os.create(
        "Use pytest legacy plugin",
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )
    memory_os.forget(
        forgotten["id"], expected_version=1, actor="user", reason="obsolete"
    )
    memory_os.create(
        "Use pytest in another repository",
        project_id="workspace:other",
        workspace_path="E:/other",
    )

    report = memory_os.recall(
        "pytest unit testing preference",
        project_id="workspace:abc",
        workspace_path="E:/repo",
        top_k=5,
        min_score=0.01,
    )

    assert report["algorithm"] == "hybrid_bm25_hashing_vector"
    assert report["indexed"] == 1
    assert [item["id"] for item in report["items"]] == [str(active["id"])]
    assert report["items"][0]["score_details"]["algorithm"] == "bm25"
    assert report["retrieval_uid"]


def test_scoped_recall_preserves_active_global_user_memory_policy():
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    global_user = memory_os.create(
        "Always use concise commit messages",
        mem_type="preference",
        source="user",
    )
    memory_os.create(
        "Never expose this runtime-generated global record",
        source="runtime",
    )

    report = memory_os.recall(
        "concise commit messages",
        project_id="workspace:abc",
        workspace_path="E:/repo",
        min_score=0.01,
    )

    assert report["indexed"] == 1
    assert [item["id"] for item in report["items"]] == [str(global_user["id"])]


def test_retrieval_telemetry_never_contains_raw_query_content_or_workspace_path():
    from arforge.database import MemoryRetrievalEvent, get_session
    from arforge.memory_os import MemoryOS

    secret_path = "E:/Private/Customer-A"
    secret_query = "customer alpha password rotation preference"
    secret_content = "Customer alpha prefers weekly password rotation"
    memory_os = MemoryOS()
    memory_os.create(
        secret_content,
        project_id="workspace:private",
        workspace_path=secret_path,
    )

    report = memory_os.recall(
        secret_query,
        project_id="workspace:private",
        workspace_path=secret_path,
        min_score=0.01,
    )

    with get_session() as session:
        event = session.query(MemoryRetrievalEvent).filter_by(
            retrieval_uid=report["retrieval_uid"]
        ).one()
        serialized = str(
            {
                "scope_id": event.scope_id,
                "query_fingerprint": event.query_fingerprint,
                "returned": event.returned,
                "feedback": event.feedback,
            }
        )
    assert secret_query not in serialized
    assert secret_content not in serialized
    assert secret_path not in serialized
    assert event.query_fingerprint.startswith("sha256:")
    assert event.scope_id.startswith("scope:")


def test_empty_recall_is_bounded_and_measured_without_raw_query():
    from arforge.database import MemoryRetrievalEvent, get_session
    from arforge.memory_os import MemoryOS

    report = MemoryOS().recall(
        "   ",
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )

    assert report["items"] == []
    assert report["indexed"] == 0
    with get_session() as session:
        event = session.query(MemoryRetrievalEvent).one()
        assert event.candidate_count == 0
        assert event.returned == []
        assert event.query_fingerprint.startswith("sha256:")


def test_actual_recall_feedback_and_quality_are_not_synthetic_self_recall():
    from arforge.memory_os import MemoryOS, memory_scope_id

    memory_os = MemoryOS()
    useful = memory_os.create(
        "Use pytest for unit tests",
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )
    first = memory_os.recall(
        "pytest tests",
        project_id="workspace:abc",
        workspace_path="E:/repo",
        min_score=0.01,
    )
    memory_os.recall(
        "unmatched astronomy term",
        project_id="workspace:abc",
        workspace_path="E:/repo",
        min_score=0.5,
    )
    memory_os.record_recall_feedback(
        first["retrieval_uid"],
        useful_memory_ids=[useful["id"]],
        actor="user",
    )

    metrics = memory_os.recall_quality(
        scope_id=memory_scope_id("workspace:abc", "E:/repo")
    )

    assert metrics["measurement"] == "actual_recall"
    assert metrics["recalls"] == 2
    assert metrics["empty_recall_rate"] == 0.5
    assert metrics["feedback_coverage"] == 0.5
    assert metrics["useful_recall_rate"] == 1.0
    assert metrics["stale_or_inactive_recall_rate"] == 0.0
    assert metrics["synthetic_self_recall"] is False


def test_scoped_semantic_compatibility_api_routes_through_measured_recall():
    from arforge.database import MemoryRetrievalEvent, get_session
    from arforge.memory import save_memory_v2
    from arforge.semantic_memory import semantic_search_memories

    memory_id = save_memory_v2(
        "Use pytest for unit tests",
        project_id="workspace:abc",
        workspace_path="E:/repo",
    )

    report = semantic_search_memories(
        "pytest tests",
        project_id="workspace:abc",
        workspace_path="E:/repo",
        min_score=0.01,
    )

    assert report["items"][0]["id"] == str(memory_id)
    assert report["retrieval_uid"]
    with get_session() as session:
        assert session.query(MemoryRetrievalEvent).count() == 1


def test_unscoped_legacy_semantic_index_also_excludes_candidates():
    from arforge.memory_os import MemoryOS
    from arforge.semantic_memory import rebuild_semantic_index, semantic_search_memories

    active = MemoryOS().create("active pytest workflow")
    MemoryOS().create("candidate secret pytest workflow", lifecycle="candidate")
    rebuild_semantic_index(force=True)

    results = semantic_search_memories("pytest workflow", top_k=10, min_score=0.01)

    assert [item["id"] for item in results] == [active["id"]]
