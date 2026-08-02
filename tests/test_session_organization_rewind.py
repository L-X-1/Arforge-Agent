from __future__ import annotations

from arforge.bridge import dispatch
from arforge.product.session_runtime import SessionRuntime
from arforge.product.state_store import BridgeStateStore
from arforge.scheduled_prompt_runtime import ScheduledPromptManager


class HistoryAgent:
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
        agent_factory=HistoryAgent,
        store=store,
        scheduler=ScheduledPromptManager(tmp_path / "schedules.json"),
    )
    return store, runtime


def test_session_tags_persist_filter_and_copy_to_fork(tmp_path):
    store, runtime = _runtime(tmp_path)
    first = runtime.create_session()
    second = runtime.create_session()
    runtime.rename_session(first["session_id"], "Release review")
    runtime.update_session_tags(first["session_id"], ["Release", "Backend", "release"])
    runtime.update_session_tags(second["session_id"], ["Frontend"])

    filtered = runtime.filter_sessions(tags=["backend"], query="release")
    assert [item["session_id"] for item in filtered["items"]] == [first["session_id"]]
    assert filtered["items"][0]["tags"] == ["Backend", "Release"]

    forked = runtime.fork_session(first["session_id"])
    assert forked["tags"] == ["Backend", "Release"]

    recovered = SessionRuntime(
        lambda _event: None,
        agent_factory=HistoryAgent,
        store=BridgeStateStore(store.path),
        scheduler=ScheduledPromptManager(tmp_path / "schedules-2.json"),
    )
    assert recovered.get_session(first["session_id"])["tags"] == ["Backend", "Release"]


def test_rewind_preview_is_stale_safe_and_keeps_workspace_side_effects(tmp_path):
    store, runtime = _runtime(tmp_path)
    session = runtime.create_session()
    session_id = session["session_id"]
    store.save_message(session_id, "user", "first request")
    store.save_message(session_id, "assistant", "first answer")
    checkpoint = runtime.create_session_checkpoint(session_id, "before experiment")
    store.save_message(session_id, "user", "second request")
    store.save_message(session_id, "assistant", "second answer")
    side_effect = tmp_path / "result.txt"
    side_effect.write_text("keep me", encoding="utf-8")

    preview = runtime.preview_session_rewind(
        session_id,
        checkpoint["checkpoint_id"],
    )
    assert preview["messages_to_rewind"] == 2
    assert preview["workspace_changes_reverted"] is False

    store.save_message(session_id, "user", "concurrent message")
    stale = dispatch(
        {
            "version": "1.2",
            "method": "session.rewind.apply",
            "params": {
                "session_id": session_id,
                "checkpoint_id": checkpoint["checkpoint_id"],
                "expected_last_sequence": preview["expected_last_sequence"],
            },
        },
        runtime=runtime,
    )
    assert stale["ok"] is False
    assert stale["error"]["code"] == "STALE_PREVIEW"

    fresh = runtime.preview_session_rewind(session_id, checkpoint["checkpoint_id"])
    applied = runtime.apply_session_rewind(
        session_id,
        checkpoint["checkpoint_id"],
        fresh["expected_last_sequence"],
    )
    assert applied["removed_messages"] == 3
    assert applied["remaining_messages"] == 2
    assert side_effect.read_text(encoding="utf-8") == "keep me"
    assert runtime._sessions[session_id].agent.conversation_history == [
        {"role": "user", "content": "first request"},
        {"role": "assistant", "content": "first answer"},
    ]
    assert [item["content"] for item in store.load_messages(session_id)] == [
        "first request",
        "first answer",
    ]


def test_bridge_exposes_tags_checkpoints_and_rewind(tmp_path):
    store, runtime = _runtime(tmp_path)
    session = runtime.create_session()
    session_id = session["session_id"]
    store.save_message(session_id, "user", "baseline")

    tagged = dispatch(
        {
            "version": "1.2",
            "method": "session.tags.update",
            "params": {"session_id": session_id, "tags": ["audit"]},
        },
        runtime=runtime,
    )
    assert tagged["ok"] is True
    listed = dispatch(
        {
            "version": "1.2",
            "method": "session.list",
            "params": {"tags": ["AUDIT"]},
        },
        runtime=runtime,
    )
    assert listed["data"]["count"] == 1

    checkpoint = dispatch(
        {
            "version": "1.2",
            "method": "session.checkpoint.create",
            "params": {"session_id": session_id, "label": "baseline"},
        },
        runtime=runtime,
    )
    assert checkpoint["ok"] is True
    store.save_message(session_id, "assistant", "temporary")
    preview = dispatch(
        {
            "version": "1.2",
            "method": "session.rewind.preview",
            "params": {
                "session_id": session_id,
                "checkpoint_id": checkpoint["data"]["checkpoint_id"],
            },
        },
        runtime=runtime,
    )
    assert preview["data"]["messages_to_rewind"] == 1

    described = dispatch({"version": "1.2", "method": "protocol.describe"})
    for method in (
        "session.tags.update",
        "session.checkpoint.create",
        "session.checkpoint.list",
        "session.rewind.preview",
        "session.rewind.apply",
    ):
        assert method in described["data"]["methods"]
