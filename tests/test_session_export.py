"""Contract tests for safe, portable Bridge session exports."""

from __future__ import annotations

import json

from arforge.bridge import dispatch
from arforge.product.session_runtime import SessionRuntime
from arforge.product.state_store import BridgeStateStore


class ExportAgent:
    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, _value: str):
        return iter(())


def _runtime(tmp_path):
    store = BridgeStateStore(tmp_path / "state.db")
    runtime = SessionRuntime(lambda _event: None, agent_factory=ExportAgent, store=store)
    session = runtime.create_session()
    return store, runtime, session["session_id"]


def test_json_export_contains_visible_messages_but_not_internal_channels(tmp_path):
    store, runtime, session_id = _runtime(tmp_path)
    store.save_message(session_id, "user", "Please inspect the result")
    store.save_message(
        session_id,
        "assistant",
        "The result is ready.",
        reasoning={"thinking": "internal scratchpad"},
        tool_events=[{"kind": "tool", "tool_name": "read_file", "summary": "private command output"}],
        artifacts=[{"artifact_id": "artifact-1", "path": "output.txt"}],
    )

    exported = runtime.export_session(session_id, "json")
    transcript = json.loads(exported["content"])

    assert exported["mime_type"] == "application/json"
    assert exported["filename"].endswith(".json")
    assert [item["content"] for item in transcript["messages"]] == [
        "Please inspect the result",
        "The result is ready.",
    ]
    assert transcript["messages"][1]["artifacts"] == [
        {
            "artifact_id": "artifact-1",
            "path": "output.txt",
            "mime": "text/plain",
            "size_bytes": 0,
            "created_at": "",
            "source": "file.write",
        }
    ]
    assert "internal scratchpad" not in exported["content"]
    assert "private command output" not in exported["content"]


def test_markdown_export_is_available_through_bridge_and_validates_format(tmp_path):
    store, runtime, session_id = _runtime(tmp_path)
    store.save_message(session_id, "user", "Hello")

    response = dispatch(
        {
            "version": "1.2",
            "method": "session.export",
            "params": {"session_id": session_id, "format": "markdown"},
        },
        runtime=runtime,
    )

    assert response["ok"] is True
    assert response["data"]["mime_type"] == "text/markdown"
    assert "## User" in response["data"]["content"]
    assert "Hello" in response["data"]["content"]

    invalid = dispatch(
        {
            "version": "1.2",
            "method": "session.export",
            "params": {"session_id": session_id, "format": "html"},
        },
        runtime=runtime,
    )
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"
