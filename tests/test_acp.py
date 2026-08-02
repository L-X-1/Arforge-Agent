from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path

import pytest

from arforge.acp import AcpError, AcpServer
from arforge.permission import confirmation_scope, request_confirmation


class FakeAgent:
    def __init__(self):
        self.conversation_history: list[dict[str, str]] = []

    def should_use_multiagent(self, _user_input: str) -> bool:
        return False

    def chat_stream(self, _user_input: str):
        yield {"type": "answer_delta", "data": {"content": "hello"}}
        yield {"type": "answer_delta", "data": {"content": " world"}}
        yield {"type": "done", "data": {}}


@pytest.fixture
def server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    output = io.StringIO()
    instance = AcpServer(
        output,
        workspace=tmp_path,
        state_path=tmp_path / "ide.db",
        agent_factory=FakeAgent,
    )
    monkeypatch.setattr(
        instance,
        "_require_auth",
        lambda: {
            "resolved": True,
            "provider": "deepseek",
            "model": "deepseek-chat",
        },
    )
    yield instance, output
    instance.close()


def test_initialize_advertises_only_implemented_capabilities(server) -> None:
    instance, _ = server
    result = instance.dispatch(
        "initialize",
        {"protocolVersion": 1, "clientCapabilities": {}},
    )

    assert result["protocolVersion"] == 1
    assert result["agentInfo"]["name"] == "Arforge Agent"
    assert result["agentCapabilities"]["loadSession"] is True
    assert result["agentCapabilities"]["promptCapabilities"]["image"] is True
    assert result["agentCapabilities"]["mcpCapabilities"] == {
        "http": True,
        "sse": True,
    }


def test_new_prompt_stream_and_history_replay_use_canonical_runtime(server) -> None:
    instance, output = server
    instance.dispatch(
        "initialize",
        {"protocolVersion": 1, "clientCapabilities": {}},
    )
    created = instance.dispatch("session/new", {"cwd": str(instance.workspace)})
    session_id = created["sessionId"]

    result = instance.dispatch(
        "session/prompt",
        {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": "Say hello"}],
        },
    )

    assert result["stopReason"] == "end_turn"
    messages = [
        json.loads(line)
        for line in output.getvalue().splitlines()
        if line.strip()
    ]
    chunks = [
        message["params"]["update"]["content"]["text"]
        for message in messages
        if message.get("method") == "session/update"
        and message["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
    ]
    assert "".join(chunks) == "hello world"

    output.seek(0)
    output.truncate()
    loaded = instance.dispatch(
        "session/load",
        {"sessionId": session_id, "cwd": str(instance.workspace)},
    )
    assert loaded["configOptions"]
    replay = [
        json.loads(line)["params"]["update"]["sessionUpdate"]
        for line in output.getvalue().splitlines()
    ]
    assert replay == ["user_message_chunk", "agent_message_chunk"]


def test_prompt_converts_embedded_resources_and_materializes_images(server) -> None:
    instance, _ = server
    pixel = base64.b64encode(b"small-image").decode("ascii")
    prompt, context = instance._prompt_content(
        [
            {"type": "text", "text": "Inspect the attachment"},
            {
                "type": "resource",
                "resource": {"uri": "file:///note.txt", "text": "embedded text"},
            },
            {"type": "image", "mimeType": "image/png", "data": pixel},
        ]
    )

    assert "embedded text" in prompt
    assert len(context["paths"]) == 1
    image = Path(context["paths"][0]["path"])
    assert image.is_file()
    assert image.read_bytes() == b"small-image"
    assert instance.workspace in image.parents


def test_mode_and_thinking_are_session_scoped(server) -> None:
    instance, _ = server
    instance.dispatch(
        "initialize",
        {"protocolVersion": 1, "clientCapabilities": {}},
    )
    session_id = instance.dispatch("session/new", {})["sessionId"]

    instance.dispatch(
        "session/set_mode",
        {"sessionId": session_id, "modeId": "plan"},
    )
    result = instance.dispatch(
        "session/set_config_option",
        {"sessionId": session_id, "configId": "thinking", "value": "high"},
    )

    values = {item["id"]: item["currentValue"] for item in result["configOptions"]}
    assert values["mode"] == "plan"
    assert values["thinking"] == "high"


def test_nested_agent_transport_is_rejected_instead_of_silently_ignored(server) -> None:
    instance, _ = server
    instance.dispatch(
        "initialize",
        {"protocolVersion": 1, "clientCapabilities": {}},
    )

    with pytest.raises(AcpError, match="nested agent-protocol"):
        instance.dispatch(
            "session/new",
            {
                "mcpServers": [
                    {"name": "nested", "transport": "acp", "command": "other-agent"}
                ]
            },
        )


def test_stdio_mcp_servers_are_forwarded_and_registered(server) -> None:
    instance, _ = server
    instance.dispatch(
        "initialize",
        {"protocolVersion": 1, "clientCapabilities": {}},
    )

    result = instance.dispatch(
        "session/new",
        {
            "mcpServers": [
                {
                    "name": "ide-test",
                    "transport": "stdio",
                    "command": sys.executable,
                    "args": ["-m", "arforge.mcp_test_server"],
                    "env": {},
                }
            ]
        },
    )

    assert result["sessionId"]
    from arforge.mcp_client_runtime import get_mcp_client_manager

    servers = get_mcp_client_manager().list_servers()
    connected = next(item for item in servers if item["name"] == "ide-test")
    assert connected["transport"] == "stdio"
    assert connected["tool_count"] >= 1


def test_confirmation_scope_routes_host_decision_without_global_side_effect() -> None:
    decisions: list[tuple[str, str]] = []

    with confirmation_scope(
        lambda risk, description: decisions.append((risk, description)) or True
    ):
        assert request_confirmation("medium", "write file") is True

    assert decisions == [("medium", "write file")]
