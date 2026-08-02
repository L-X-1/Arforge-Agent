from __future__ import annotations


class PoorAdapter:
    model_name = "compatible[8k]"

    def generate(self, *_args, **_kwargs):
        return "generic progress"


def _messages() -> list[dict]:
    return [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "Implement the project feature."},
        {"role": "user", "content": "From now on, always use pytest for this workspace."},
        {"role": "assistant", "content": "Architecture decision: use event sourcing for authentication."},
        {"role": "user", "content": "I prefer the workspace UI color #0F172A."},
        {"role": "assistant", "content": "Pending: add rate-limit documentation."},
        {"role": "tool", "tool_call_id": "test", "content": "pytest -q\n17 passed"},
        {"role": "tool", "tool_call_id": "error", "content": "Traceback\nKeyError: missing_tenant"},
        *({"role": "assistant", "content": f"progress {index}"} for index in range(10)),
    ]


def test_compaction_allocates_durable_facts_to_workspace_memory(tmp_path):
    from arforge.auto_memory import workspace_memory_scope
    from arforge.core.compaction import compact
    from arforge.database import init_db
    from arforge.memory import query_memories_for_scope
    from arforge.workspace_context import execution_scope

    init_db()
    with execution_scope("memory-layer-session", workspace=tmp_path):
        _result, stats = compact(
            _messages(),
            PoorAdapter(),
            "compatible[8k]",
            keep_recent=3,
            persist_durable=True,
        )

    project_id, workspace_path = workspace_memory_scope(tmp_path)
    stored = query_memories_for_scope(
        project_id=project_id,
        workspace_path=workspace_path,
        include_global_user_memories=False,
    )
    text = "\n".join(item["content"] for item in stored)

    assert stats["long_term_memories_saved"] >= 3
    assert stats["long_term_candidates"] >= 3
    assert stats["short_term_facts"] >= 3
    assert "always use pytest" in text
    assert "event sourcing" in text
    assert "#0F172A" in text
    assert "rate-limit documentation" not in text
    assert "17 passed" not in text
    assert "missing_tenant" not in text
    assert all(item["source"] == "compaction" for item in stored)


def test_compaction_fact_policy_keeps_operational_state_short_term():
    from arforge.core.compaction import classify_compaction_fact

    assert classify_compaction_fact("架构决定: use event sourcing")["tier"] == "long_term"
    assert classify_compaction_fact("用户偏好: prefer pytest")["tier"] == "long_term"
    assert classify_compaction_fact("用户硬约束: MUST do this for the current task")["tier"] == "short_term"
    assert classify_compaction_fact("用户硬约束: From now on, always use pytest")["tier"] == "long_term"
    assert classify_compaction_fact("待办事项: add documentation")["tier"] == "short_term"
    assert classify_compaction_fact("已验证测试: 17 passed")["tier"] == "short_term"
    assert classify_compaction_fact("错误指纹: abc KeyError")["tier"] == "short_term"


def test_durable_compaction_memory_survives_database_restart_and_is_workspace_scoped(tmp_path, monkeypatch):
    from arforge.auto_memory import workspace_memory_scope
    from arforge.core.agent_core import ArforgeAgent
    from arforge.core.compaction import compact
    from arforge.database import dispose_engines, init_db
    from arforge.memory import query_memories_for_scope
    from arforge.workspace_context import execution_scope

    database_path = (tmp_path / "durable-memory.db").as_posix()
    monkeypatch.setenv("ARFORGE_DB_URL", f"sqlite:///{database_path}")
    dispose_engines()
    init_db()
    workspace_a = tmp_path / "a"
    workspace_b = tmp_path / "b"
    workspace_a.mkdir()
    workspace_b.mkdir()
    with execution_scope("first-process", workspace=workspace_a):
        compact(_messages(), PoorAdapter(), "compatible[8k]", keep_recent=3, persist_durable=True)

    # Dispose every SQLAlchemy engine to model a complete process restart, then
    # rebuild a fresh agent and recall from the file-backed long-term store.
    dispose_engines()
    init_db()
    recreated = ArforgeAgent()
    with execution_scope("recreated-process", workspace=workspace_a):
        recalled = recreated.refresh_memory_text("authentication architecture and UI preference")
    assert "event sourcing" in recalled
    assert "#0F172A" in recalled

    project_b, path_b = workspace_memory_scope(workspace_b)
    assert query_memories_for_scope(
        project_id=project_b,
        workspace_path=path_b,
        include_global_user_memories=False,
    ) == []
