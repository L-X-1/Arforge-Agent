"""Tests for the unified structured message model and its storage migration."""

from __future__ import annotations

from arforge.product.message_model import (
    Artifact,
    MessagePayload,
    ReasoningPayload,
    ToolEvent,
)
from arforge.product.state_store import BridgeStateStore


def _store(tmp_path):
    return BridgeStateStore(tmp_path / "state.db")


def test_artifact_infers_binary_mime_and_image_state_from_path():
    spreadsheet = Artifact.from_dict({"artifact_id": "a", "path": "report.xlsx"})
    image = Artifact.from_dict({"artifact_id": "b", "path": "preview.png"})

    assert spreadsheet.mime == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert image.mime == "image/png"
    assert image.is_image is True


def test_payload_splits_into_flat_storage_columns():
    payload = MessagePayload(
        content="最终答案",
        reasoning=ReasoningPayload(understanding="理解", thinking="推理"),
        tool_events=[ToolEvent(kind="file.write", tool_name="file.write", status="completed", target_path="out.txt")],
        artifacts=[Artifact(artifact_id="a1", path="out.txt", size_bytes=5)],
    )
    flat = payload.to_storage()
    assert flat["content"] == "最终答案"
    assert flat["state"] == "complete"
    assert "理解" in flat["reasoning_json"]
    assert "out.txt" in flat["tool_events_json"]
    assert "a1" in flat["artifacts_json"]


def test_storage_round_trip_preserves_all_channels(tmp_path):
    store = _store(tmp_path)
    store.save_session({
        "session_id": "s1", "status": "active", "created_at": "t", "updated_at": "t",
        "project_id": "default", "title": "新会话",
    })
    store.save_message(
        "s1", "assistant", "干净的答案",
        reasoning={"understanding": "U", "thinking": "T", "evidence": "E", "reflection": "R"},
        tool_events=[{"kind": "file.write", "status": "completed", "target_path": "C:\\Desktop\\x.txt"}],
        artifacts=[{"artifact_id": "art", "path": "C:\\Desktop\\x.txt", "size_bytes": 12}],
    )
    messages = store.load_messages("s1")
    assert len(messages) == 1
    payload = MessagePayload.from_storage(messages[0])
    assert payload.content == "干净的答案"
    assert payload.reasoning.thinking == "T"
    assert payload.tool_events[0].target_path == "C:\\Desktop\\x.txt"
    assert payload.artifacts[0].artifact_id == "art"


def test_legacy_xml_content_is_migrated_on_read(tmp_path):
    """Older rows stored the whole XML response in content; reading must split it
    so the answer body stays clean and the reasoning lands in the collapsible
    channel."""
    store = _store(tmp_path)
    store.save_session({
        "session_id": "s2", "status": "active", "created_at": "t", "updated_at": "t",
        "project_id": "default", "title": "新会话",
    })
    raw = "\n".join([
        "<understanding>用户需要问候</understanding>",
        "<thinking>内部思考不应作为正文显示</thinking>",
        "<evidence>用户输入：你好</evidence>",
        "<reflection>无需展开输出</reflection>",
        "<answer>你好！有什么我可以帮你的吗？</answer>",
    ])
    # Simulate a legacy write: content holds the XML, no structured channels.
    store.save_message("s2", "assistant", raw)

    messages = store.load_messages("s2")
    payload = MessagePayload.from_storage(messages[0])
    assert payload.content == "你好！有什么我可以帮你的吗？"
    assert "<thinking>" not in payload.content
    assert payload.reasoning.thinking == "内部思考不应作为正文显示"
    assert payload.reasoning.understanding == "用户需要问候"


def test_completed_event_shape_has_clean_answer_and_reasoning():
    payload = MessagePayload(
        content="答案正文",
        reasoning=ReasoningPayload(thinking="推理过程"),
    )
    event = payload.to_completed_event(meta={"mode": "single"}, usage={"input_tokens": 10})
    assert event["answer"] == "答案正文"
    assert event["reasoning"]["thinking"] == "推理过程"
    assert event["meta"]["mode"] == "single"
    assert event["usage"]["input_tokens"] == 10
    assert event["tool_events"] == []
    assert event["artifacts"] == []


def test_empty_reasoning_is_allowed_for_simple_greetings():
    payload = MessagePayload(content="你好！")
    flat = payload.to_storage()
    assert flat["reasoning_json"] == ""  # empty reasoning not stored
    event = payload.to_completed_event()
    assert event["reasoning"] == {"understanding": "", "thinking": "", "evidence": "", "reflection": ""}
    assert event["answer"] == "你好！"
