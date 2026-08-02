"""v1-1.5 任务级回滚（run_transaction）测试。"""

from __future__ import annotations

import pytest

from arforge.core.hooks import HookContext, HookEvent, get_hook_manager, reset_hook_manager
from arforge.core.run_transaction import (
    RunTransaction,
    get_run_transaction,
    install_run_transaction_hook,
    list_run_ids,
    load_run,
    load_run_trace,
    persist_run_transaction,
    reset_run_transaction,
    revert_run,
    run_transaction_scope,
    save_run_messages,
    save_run_trace,
)
from arforge.core.run_transaction import _snapshot_hook
from arforge.workspace_context import execution_scope


@pytest.fixture(autouse=True)
def _iso(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "home"))  # 隔离 runs 目录
    reset_run_transaction()
    yield
    reset_run_transaction()


def test_snapshot_records_first_only():
    t = RunTransaction()
    t.snapshot("/a", "v1")
    t.snapshot("/a", "v2")  # 第二次不覆盖，保留 run 起点
    assert t.entries() == {"/a": "v1"}


def test_transaction_scope_isolates_nested_execution_and_restores_parent():
    get_run_transaction().snapshot("/parent", "parent")

    with run_transaction_scope():
        get_run_transaction().snapshot("/child", "child")
        assert get_run_transaction().entries() == {"/child": "child"}

    assert get_run_transaction().entries() == {"/parent": "parent"}


def test_execution_scope_keeps_transactions_separate_between_sessions():
    with execution_scope("session-a"):
        get_run_transaction().snapshot("/a", "a")
        with execution_scope("session-b"):
            get_run_transaction().snapshot("/b", "b")
            assert get_run_transaction().entries() == {"/b": "b"}
        assert get_run_transaction().entries() == {"/a": "a"}


def test_to_dict_structure():
    t = RunTransaction()
    t.snapshot("/a", "orig")
    t.snapshot("/b", None)
    d = t.to_dict("rid")
    assert d["run_id"] == "rid"
    assert {"path": "/a", "original": "orig"} in d["entries"]
    assert {"path": "/b", "original": None} in d["entries"]


def test_to_dict_encodes_binary_snapshot_without_losing_text_compatibility():
    transaction = RunTransaction()
    transaction.snapshot("/report.docx", b"PK\x03\x04document")

    entry = transaction.to_dict("binary")["entries"][0]

    assert entry["path"] == "/report.docx"
    assert entry["original"] is None
    assert entry["original_b64"]


def test_persist_and_load_roundtrip():
    get_run_transaction().snapshot("/x", "hello")
    persist_run_transaction("run-1")
    data = load_run("run-1")
    assert data["entries"][0] == {"path": "/x", "original": "hello"}


def test_list_run_ids_sorted():
    get_run_transaction().snapshot("/x", "a")
    persist_run_transaction("20260101-000001")
    persist_run_transaction("20260101-000002")
    assert list_run_ids() == ["20260101-000001", "20260101-000002"]


def test_list_run_ids_ignores_messages_and_trace_only_runs():
    save_run_messages("messages-only", [{"role": "user", "content": "x"}])
    save_run_trace("trace-only", [{"event": "final"}], {}, "done")
    get_run_transaction().snapshot("/x", "a")
    persist_run_transaction("real-txn")
    assert list_run_ids() == ["real-txn"]


def test_load_missing_raises():
    with pytest.raises(FileNotFoundError):
        load_run("nope")


def test_save_load_trace_roundtrip():
    trace = [{"step": 1, "event": "tool", "tool": "run_cmd", "success": True}]
    obs = {"summary": {"llm_calls": 1, "tool_calls": 1, "total_tokens": 42, "cost_cny": 0.001}}
    save_run_trace("trace-1", trace, obs, "final answer")
    data = load_run_trace("trace-1")
    assert data["run_id"] == "trace-1"
    assert data["trace"] == trace
    assert data["observability"] == obs
    assert data["answer"] == "final answer"


def test_revert_restores_existing_and_deletes_new(tmp_path):
    existing = tmp_path / "exist.py"
    existing.write_text("original\n", encoding="utf-8")
    created = tmp_path / "new.py"

    txn = get_run_transaction()
    txn.snapshot(str(existing), "original\n")  # 改前原内容
    txn.snapshot(str(created), None)  # run 新建

    existing.write_text("MODIFIED\n", encoding="utf-8")  # 模拟 run 改动
    created.write_text("created\n", encoding="utf-8")
    persist_run_transaction("r")

    restored, deleted, skipped = revert_run("r")
    assert (restored, deleted, skipped) == (1, 1, 0)
    assert existing.read_text(encoding="utf-8") == "original\n"
    assert not created.exists()


def test_revert_restores_binary_document_snapshot(tmp_path):
    document = tmp_path / "report.docx"
    original = b"PK\x03\x04original-document"
    document.write_bytes(original)
    get_run_transaction().snapshot(str(document), original)
    document.write_bytes(b"PK\x03\x04changed-document")
    persist_run_transaction("binary-document")

    restored, deleted, skipped = revert_run("binary-document")

    assert (restored, deleted, skipped) == (1, 0, 0)
    assert document.read_bytes() == original


def test_snapshot_hook_captures_original(tmp_path, monkeypatch):
    f = tmp_path / "a.py"
    f.write_text("v1\n", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: f)
    ctx = HookContext(HookEvent.PRE_TOOL_USE, tool_name="write_file", tool_args={"filename": "a.py"})
    _snapshot_hook(ctx)
    assert get_run_transaction().entries()[str(f)] == "v1\n"


def test_snapshot_hook_new_file_records_none(tmp_path, monkeypatch):
    f = tmp_path / "ghost.py"  # 不存在
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: f)
    ctx = HookContext(HookEvent.PRE_TOOL_USE, tool_name="write_file", tool_args={"filename": "ghost.py"})
    _snapshot_hook(ctx)
    assert get_run_transaction().entries()[str(f)] is None


def test_snapshot_hook_preserves_deleted_file_for_revert(tmp_path, monkeypatch):
    f = tmp_path / "removed.py"
    f.write_text("original\n", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda _fn: f)
    ctx = HookContext(
        HookEvent.PRE_TOOL_USE,
        tool_name="delete_file",
        tool_args={"filename": "removed.py"},
    )
    _snapshot_hook(ctx)
    assert get_run_transaction().entries()[str(f)] == "original\n"


def test_snapshot_hook_preserves_binary_docx_and_normalizes_suffix(tmp_path, monkeypatch):
    document = tmp_path / "report.docx"
    original = b"PK\x03\x04document"
    document.write_bytes(original)
    resolved_names = []

    def resolve(filename):
        resolved_names.append(filename)
        return document

    monkeypatch.setattr("arforge.tools.file_tools._resolve", resolve)
    _snapshot_hook(
        HookContext(
            HookEvent.PRE_TOOL_USE,
            tool_name="write_docx",
            tool_args={"filename": "report"},
        )
    )

    assert resolved_names == ["report.docx"]
    assert get_run_transaction().entries()[str(document)] == original


def test_snapshot_hook_preserves_undecodable_existing_file_as_bytes(tmp_path, monkeypatch):
    binary = tmp_path / "asset.bin"
    original = b"\x00\xff\xfe\x80binary"
    binary.write_bytes(original)
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda _fn: binary)

    _snapshot_hook(
        HookContext(
            HookEvent.PRE_TOOL_USE,
            tool_name="delete_file",
            tool_args={"filename": "asset.bin"},
        )
    )

    assert get_run_transaction().entries()[str(binary)] == original


def test_snapshot_hook_ignores_non_write(tmp_path, monkeypatch):
    f = tmp_path / "a.py"
    f.write_text("x", encoding="utf-8")
    monkeypatch.setattr("arforge.tools.file_tools._resolve", lambda fn: f)
    ctx = HookContext(HookEvent.PRE_TOOL_USE, tool_name="read_file", tool_args={"filename": "a.py"})
    _snapshot_hook(ctx)
    assert get_run_transaction().is_empty()


def test_snapshot_hook_install_is_idempotent():
    reset_hook_manager()
    install_run_transaction_hook()
    install_run_transaction_hook()
    manager = get_hook_manager()
    assert manager.handler_names(HookEvent.PRE_TOOL_USE) == {"run_transaction"}
