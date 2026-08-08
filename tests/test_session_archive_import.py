from __future__ import annotations

import json
import sqlite3

import pytest

from arforge.product.direct_dispatch import dispatch
from arforge.product.session_runtime import SessionRuntime, SessionRuntimeError
from arforge.product.state_store import BridgeStateStore


class ArchiveAgent:
    def __init__(self):
        self.conversation_history: list[dict] = []

    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, _value: str):
        return iter(())


def _runtime(tmp_path):
    store = BridgeStateStore(tmp_path / "state.db")
    runtime = SessionRuntime(
        lambda _event: None,
        agent_factory=ArchiveAgent,
        store=store,
    )
    return store, runtime


def test_archive_filters_bulk_updates_and_persists(tmp_path):
    store, runtime = _runtime(tmp_path)
    first = runtime.create_session()
    second = runtime.create_session()

    result = runtime.set_sessions_archived([first["session_id"]], True)

    assert result["count"] == 1
    assert result["items"][0]["archived_at"]
    assert [item["session_id"] for item in runtime.filter_sessions()["items"]] == [
        second["session_id"]
    ]
    assert [item["session_id"] for item in runtime.filter_sessions(archive="only")["items"]] == [
        first["session_id"]
    ]

    recovered = SessionRuntime(
        lambda _event: None,
        agent_factory=ArchiveAgent,
        store=BridgeStateStore(store.path),
    )
    assert recovered.get_session(first["session_id"])["archived_at"]
    assert recovered.get_session(first["session_id"])["resumable"] is False

    restored = recovered.set_sessions_archived([first["session_id"]], False)
    assert restored["items"][0]["archived_at"] is None
    assert {item["session_id"] for item in recovered.filter_sessions()["items"]} == {
        first["session_id"],
        second["session_id"],
    }


def test_bulk_archive_rolls_back_if_persistent_state_changes_concurrently(tmp_path):
    store, runtime = _runtime(tmp_path)
    first = runtime.create_session()
    second = runtime.create_session()
    with store._connect() as connection:
        connection.execute(
            "DELETE FROM bridge_sessions WHERE session_id=?",
            (second["session_id"],),
        )

    with pytest.raises(SessionRuntimeError) as captured:
        runtime.set_sessions_archived(
            [first["session_id"], second["session_id"]],
            True,
        )

    assert captured.value.code == "SESSION_STATE_CONFLICT"
    assert runtime.get_session(first["session_id"])["archived_at"] is None
    assert runtime.get_session(second["session_id"])["archived_at"] is None
    with store._connect() as connection:
        assert connection.execute(
            "SELECT archived_at FROM bridge_sessions WHERE session_id=?",
            (first["session_id"],),
        ).fetchone()[0] is None


def test_export_import_round_trip_uses_new_identity_and_omits_internal_channels(tmp_path):
    store, runtime = _runtime(tmp_path)
    original = runtime.create_session()
    runtime.rename_session(original["session_id"], "Portable review")
    runtime.update_session_tags(original["session_id"], ["release", "audit"])
    store.save_message(original["session_id"], "user", "Inspect this")
    store.save_message(
        original["session_id"],
        "assistant",
        "Visible answer",
        reasoning={"thinking": "do not import"},
        tool_events=[{"tool_name": "shell", "summary": "private"}],
    )
    archive = runtime.export_session(original["session_id"], "json")

    response = dispatch(
        {
            "version": "1.2",
            "method": "session.import",
            "params": {"content": archive["content"]},
        },
        runtime=runtime,
    )

    assert response["ok"] is True
    imported = response["data"]
    assert imported["session_id"] != original["session_id"]
    assert imported["project_id"] == original["project_id"]
    assert imported["status"] == "interrupted"
    assert imported["tags"] == ["audit", "release"]
    assert imported["imported_messages"] == 2
    assert imported["structured_channels_omitted"] is True
    rows = store.load_messages(imported["session_id"])
    assert [row["content"] for row in rows] == ["Inspect this", "Visible answer"]
    assert all(not row.get("reasoning") and not row.get("tool_events") for row in rows)


def test_invalid_or_incomplete_archives_do_not_partially_import(tmp_path):
    _store, runtime = _runtime(tmp_path)
    before = runtime.list_sessions(archive="all")["total"]

    invalid = dispatch(
        {
            "version": "1.2",
            "method": "session.import",
            "params": {"content": "{broken"},
        },
        runtime=runtime,
    )
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_SESSION_ARCHIVE"

    incomplete_payload = {
        "schema": "arforge.session.export",
        "schema_version": 1,
        "session": {"title": "Incomplete", "tags": []},
        "messages": [],
        "truncated": True,
    }
    incomplete = dispatch(
        {
            "version": "1.2",
            "method": "session.import",
            "params": {"content": json.dumps(incomplete_payload)},
        },
        runtime=runtime,
    )
    assert incomplete["ok"] is False
    assert incomplete["error"]["code"] == "INCOMPLETE_SESSION_ARCHIVE"
    assert runtime.list_sessions(archive="all")["total"] == before


def test_import_file_context_is_durable_visible_and_available_to_active_agent(tmp_path):
    store, runtime = _runtime(tmp_path)
    target = runtime.create_session()

    response = dispatch(
        {
            "version": "1.2",
            "method": "session.context.import",
            "params": {
                "session_id": target["session_id"],
                "content": "API_TOKEN=secret-value\nReference requirements",
                "source": "C:/workspace/requirements.txt",
            },
        },
        runtime=runtime,
    )

    assert response["ok"] is True
    result = response["data"]
    assert result["source_kind"] == "file"
    assert result["source"] == "C:/workspace/requirements.txt"
    assert result["imported_chars"] > 0
    assert result["truncated"] is False
    row = store.load_messages(target["session_id"])[0]
    assert "Imported reference context" in row["content"]
    assert "Reference requirements" in row["content"]
    assert "secret-value" not in row["content"]
    assert runtime.get_session(target["session_id"])["message_count"] == 1
    agent = runtime._sessions[target["session_id"]].agent
    assert agent.conversation_history[-1]["content"] == row["content"]

    recovered = SessionRuntime(
        lambda _event: None,
        agent_factory=ArchiveAgent,
        store=BridgeStateStore(store.path),
    )
    resumed = recovered.resume_session(target["session_id"])
    assert resumed["message_count"] == 1
    assert "Reference requirements" in recovered._sessions[target["session_id"]].agent.conversation_history[-1]["content"]


def test_import_session_context_uses_visible_transcript_only_and_rejects_self(tmp_path):
    store, runtime = _runtime(tmp_path)
    source = runtime.create_session()
    target = runtime.create_session()
    runtime.rename_session(source["session_id"], "Design review")
    store.save_message(source["session_id"], "user", "Review this design")
    store.save_message(
        source["session_id"],
        "assistant",
        "Visible decision",
        reasoning={"thinking": "private chain"},
        tool_events=[{"tool_name": "shell", "summary": "private tool output"}],
    )

    result = runtime.import_context(
        target["session_id"],
        source_session_id=source["session_id"],
    )

    assert result["source_kind"] == "session"
    assert result["source"] == "Design review"
    assert result["imported_messages"] == 2
    imported = store.load_messages(target["session_id"])[0]["content"]
    assert "Review this design" in imported
    assert "Visible decision" in imported
    assert "private chain" not in imported
    assert "private tool output" not in imported

    with pytest.raises(SessionRuntimeError) as captured:
        runtime.import_context(
            target["session_id"],
            source_session_id=target["session_id"],
        )
    assert captured.value.code == "INVALID_PARAMS"


def test_import_context_validation_does_not_append_partial_message(tmp_path):
    store, runtime = _runtime(tmp_path)
    target = runtime.create_session()

    response = dispatch(
        {
            "version": "1.2",
            "method": "session.context.import",
            "params": {
                "session_id": target["session_id"],
                "content": "x",
                "source_session_id": "also-set",
            },
        },
        runtime=runtime,
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "INVALID_PARAMS"
    assert store.message_count(target["session_id"]) == 0


def test_existing_database_is_migrated_with_archived_column(tmp_path):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE bridge_sessions (
                session_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )

    BridgeStateStore(path)

    with sqlite3.connect(path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(bridge_sessions)")}
    assert "archived_at" in columns
