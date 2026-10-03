"""Enterprise contract tests for primary user-message delivery."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import pytest

import arforge.tools.user_message_tools  # noqa: F401 - register the delivery tool
from arforge.core.agent_core import ArforgeAgent
from arforge.core.agent_loop_v2 import AgentLoopV2
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.product.message_model import MessagePayload
from arforge.product.session_runtime import SessionRuntime
from arforge.product.state_store import BridgeStateStore
from arforge.user_message_runtime import (
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    UserMessageError,
    delivery_scope,
    publish_user_message,
)


def test_python_builtin_registry_does_not_register_legacy_delivery_wrapper():
    """TS/Core owns the default delivery tool; Python remains explicit compatibility."""

    from arforge.tools import BUILTIN_TOOL_MODULES
    from arforge.tool_registry import REGISTRY

    assert "arforge.tools.user_message_tools" not in BUILTIN_TOOL_MODULES
    assert REGISTRY.get("deliver_user_message") is not None
    assert REGISTRY.get("deliver_user_message").source == "arforge.tools.user_message_tools"


@pytest.fixture
def isolated_workspace(tmp_path, monkeypatch):
    from arforge.tools import file_tools

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(file_tools, "WORKSPACE", workspace)
    monkeypatch.setattr(
        "arforge.ts_workspace.typescript_path_is_authorized",
        lambda path, *, primary: Path(path).resolve() == Path(primary).resolve()
        or Path(primary).resolve() in Path(path).resolve().parents,
    )
    return workspace


def test_publish_user_message_records_local_attachment_metadata(isolated_workspace):
    attachment = isolated_workspace / "report.txt"
    attachment.write_text("release evidence", encoding="utf-8")
    observed: list[dict] = []

    with delivery_scope(observed.append) as state:
        delivery = publish_user_message(
            "The release evidence is ready.",
            status="proactive",
            attachments=["report.txt"],
        )

    assert state.deliveries == [delivery]
    assert observed == [delivery]
    assert delivery["status"] == "proactive"
    assert delivery["local_only"] is True
    assert delivery["uploaded"] is False
    assert delivery["attachment_count"] == 1
    artifact = delivery["attachments"][0]
    assert artifact["path"] == str(attachment.resolve())
    assert artifact["display_name"] == "report.txt"
    assert artifact["mime"] == "text/plain"
    assert artifact["source"] == "user_message"
    assert artifact["sha256"] == hashlib.sha256(b"release evidence").hexdigest()


def test_publish_user_message_rejects_unsafe_attachments(isolated_workspace, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    executable = isolated_workspace / "unsafe.exe"
    executable.write_bytes(b"MZ")
    oversized = isolated_workspace / "oversized.txt"
    with oversized.open("wb") as handle:
        handle.truncate(MAX_ATTACHMENT_BYTES + 1)

    with pytest.raises(UserMessageError, match="outside authorized"):
        publish_user_message("outside", attachments=[str(outside)])
    with pytest.raises(UserMessageError, match="type is not allowed"):
        publish_user_message("unsafe", attachments=[str(executable)])
    with pytest.raises(UserMessageError, match="exceeds 25 MB"):
        publish_user_message("large", attachments=[str(oversized)])
    with pytest.raises(UserMessageError, match=f"no more than {MAX_ATTACHMENTS}"):
        publish_user_message("many", attachments=["missing.txt"] * (MAX_ATTACHMENTS + 1))


class _DeliveryAdapter:
    def __init__(self, attachment: Path):
        self.attachment = attachment
        self.calls = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kwargs):
        del messages, tools, tool_choice, kwargs
        self.calls += 1
        if self.calls == 1:
            return ToolCallResponse(
                content="",
                finish_reason="tool_calls",
                tool_calls=[
                    ToolCall(
                        "delivery-1",
                        "deliver_user_message",
                        json.dumps(
                            {
                                "message": "Primary visible result.",
                                "status": "normal",
                                "attachments": [str(self.attachment)],
                            }
                        ),
                    )
                ],
            )
        return ToolCallResponse(
            content="Duplicate model tail that must stay hidden.",
            finish_reason="stop",
            tool_calls=[],
        )


def test_agent_loop_makes_delivery_the_primary_answer(isolated_workspace):
    attachment = isolated_workspace / "result.md"
    attachment.write_text("# Result", encoding="utf-8")
    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    agent._adapter = _DeliveryAdapter(attachment)
    tokens: list[str] = []
    observed: list[dict] = []

    result = AgentLoopV2(agent).run_agentic(
        "deliver the result",
        max_steps=3,
        on_token=tokens.append,
        on_delivery=observed.append,
    )

    assert result.answer == "Primary visible result."
    assert result.deliveries == observed
    assert result.deliveries[0]["attachment_count"] == 1
    assert "Duplicate model tail" not in "".join(tokens)
    assert any(item.get("event") == "primary_message_delivered" for item in result.trace)


class _BridgeAgent:
    def __init__(self):
        self.conversation_history: list[dict] = []
        self.reasoning_effort = "normal"

    def should_use_multiagent(self, _text):
        return False


def _wait_for_terminal(runtime: SessionRuntime, operation_id: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        operation = runtime.get_operation(operation_id)
        if operation["status"] in {"succeeded", "failed", "cancelled", "timed_out"}:
            return operation
        time.sleep(0.01)
    raise AssertionError("operation did not finish")


def test_bridge_emits_and_persists_delivery(monkeypatch, isolated_workspace, tmp_path):
    attachment = isolated_workspace / "evidence.json"
    attachment.write_text('{"ok":true}', encoding="utf-8")

    class _Result:
        answer = "Visible bridge update."
        tool_calls: list[dict] = []
        trace: list[dict] = []
        deliveries: list[dict] = []

    def fake_run_agentic(
        self,
        user_input,
        max_steps=10,
        on_token=None,
        on_delivery=None,
        extra_system="",
        resume_messages=None,
    ):
        del self, user_input, max_steps, extra_system, resume_messages
        if on_token:
            on_token("temporary")
        delivery = publish_user_message(
            "Visible bridge update.",
            status="proactive",
            attachments=[str(attachment)],
        )
        if on_delivery is not None and not _Result.deliveries:
            # The real AgentLoop callback is invoked by delivery_scope. This
            # fallback keeps the test double honest if used outside that scope.
            on_delivery(delivery)
        _Result.deliveries = [delivery]
        if on_token:
            on_token("hidden tail")
        return _Result()

    monkeypatch.setattr(AgentLoopV2, "run_agentic", fake_run_agentic)
    events: list[dict] = []
    store = BridgeStateStore(tmp_path / "state.db")
    runtime = SessionRuntime(events.append, agent_factory=_BridgeAgent, store=store)
    session = runtime.create_session()
    operation = runtime.start_chat(session["session_id"], "修复并交付这个文件", 10_000)
    runtime.release_operation(operation["operation_id"])

    terminal = _wait_for_terminal(runtime, operation["operation_id"])
    assert terminal["status"] == "succeeded"
    delivered = next(item for item in events if item["type"] == "message.delivered")
    assert delivered["data"]["message"] == "Visible bridge update."
    completed = next(item for item in events if item["type"] == "operation.completed")
    assert completed["data"]["answer"] == "Visible bridge update."
    assert completed["data"]["delivery"]["status"] == "proactive"
    assert completed["data"]["artifacts"][0]["source"] == "user_message"

    row = next(item for item in store.load_messages(session["session_id"]) if item["role"] == "assistant")
    payload = MessagePayload.from_storage(row)
    assert payload.content == "Visible bridge update."
    assert payload.delivery is not None
    assert payload.delivery.status == "proactive"
    assert payload.delivery.attachment_count == 1
    assert payload.artifacts[0].display_name == "evidence.json"

    branch = runtime.fork_session(session["session_id"])
    branch_row = next(
        item
        for item in store.load_messages(branch["session_id"])
        if item["role"] == "assistant"
    )
    branch_payload = MessagePayload.from_storage(branch_row)
    assert branch_payload.delivery is not None
    assert branch_payload.delivery.status == "proactive"
    assert branch_payload.artifacts[0].sha256 == payload.artifacts[0].sha256
