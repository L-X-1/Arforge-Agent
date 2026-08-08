from __future__ import annotations

from arforge.auto_memory import extract_memories_from_turn, workspace_memory_scope
from arforge.product.direct_dispatch import dispatch
from arforge.memory import (
    apply_memory_governance,
    memory_governance_audit,
    query_memories,
    query_memories_for_scope,
    save_memory_v2,
)


def test_transient_instruction_is_extracted_but_not_persisted(tmp_path):
    candidates = extract_memories_from_turn(
        "现在只做收尾，不要创建临时脚本",
        auto_save=True,
        workspace_path=str(tmp_path),
    )

    assert candidates
    assert all(item["auto_save_eligible"] is False for item in candidates)
    assert query_memories(limit=20) == []


def test_durable_preference_is_persisted_inside_workspace_scope(tmp_path):
    candidates = extract_memories_from_turn(
        "以后都记住：我总是偏好使用 pytest 做单元测试",
        auto_save=True,
        workspace_path=str(tmp_path),
    )
    project_id, workspace_path = workspace_memory_scope(tmp_path)
    stored = query_memories_for_scope(project_id=project_id, workspace_path=workspace_path)

    assert any(item["auto_save_eligible"] is True for item in candidates)
    assert len(stored) == 1
    assert stored[0]["project_id"] == project_id
    assert stored[0]["workspace_path"] == workspace_path
    assert "governed" in stored[0]["tags"]


def test_unverified_error_response_never_auto_persists(tmp_path):
    candidates = extract_memories_from_turn(
        "这个实现错了，有 bug",
        assistant_response="上一轮给出了一个未经验证的修复方案",
        auto_save=True,
        workspace_path=str(tmp_path),
    )

    error = next(item for item in candidates if item["mem_type"] == "error")
    assert error["auto_save_eligible"] is False
    assert error["governance_reason"] == "review_required_error"
    assert query_memories(limit=20) == []


def test_governance_quarantines_legacy_auto_memories_reversibly(tmp_path):
    from arforge.memory_os import MemoryOS

    project_id, workspace_path = workspace_memory_scope(tmp_path)
    unsafe_id = save_memory_v2(
        "现在只做收尾，不要创建临时脚本",
        mem_type="constraint",
        source="auto",
        importance=4,
        project_id=project_id,
        workspace_path=workspace_path,
    )
    safe_id = save_memory_v2(
        "以后都记住：我总是偏好 pytest",
        mem_type="preference",
        source="auto",
        importance=3,
        project_id=project_id,
        workspace_path=workspace_path,
    )

    preview = memory_governance_audit()
    applied = apply_memory_governance()
    records = {item["id"]: item for item in query_memories(limit=20)}
    active = {item["id"] for item in query_memories_for_scope(project_id=project_id, workspace_path=workspace_path)}

    assert preview["candidate_count"] == 1
    assert preview["reversible"] is True
    assert applied["quarantined_ids"] == [unsafe_id]
    assert records[unsafe_id]["source"] == "quarantined:auto"
    assert records[unsafe_id]["lifecycle"] == "quarantined"
    assert records[unsafe_id]["importance"] == 1
    assert records[unsafe_id]["strength"] == 0.1
    assert unsafe_id not in active
    assert safe_id in active
    assert [entry["operation"] for entry in MemoryOS().history(unsafe_id)] == [
        "create",
        "quarantine",
    ]


def test_bridge_exposes_preview_and_explicit_apply_as_separate_methods():
    response = dispatch({"id": 1, "version": "1.2", "method": "memory.governance.preview"})

    assert response["ok"] is False
    assert response["error"]["code"] == "METHOD_NOT_FOUND"



