from __future__ import annotations

import json
from pathlib import Path

import pytest

import arforge.product.direct_dispatch as bridge_module
import arforge.feature_flags as feature_flags_module
from arforge.product.direct_dispatch import dispatch
from arforge.feature_flags import FeatureFlagRegistry
from arforge.product.action_runtime import ActionRuntime
from arforge.product.session_runtime import SessionRuntime


class NoopAgent:
    pass


def test_local_override_and_environment_kill_switch_have_stable_precedence(tmp_path: Path):
    state_path = tmp_path / "state" / "feature_flags.json"
    registry = FeatureFlagRegistry(state_path=state_path, environ={"ARFORGE_FEATURE_FILE_HISTORY": "off"})

    saved = registry.set_override("file_history", True)
    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    listed = registry.list()
    cleared = registry.clear_override("file_history")

    assert saved["enabled"] is False
    assert saved["source"] == "environment"
    assert persisted["overrides"] == {"file_history": True}
    assert next(item for item in listed["items"] if item["flag_id"] == "file_history")["source"] == "environment"
    assert cleared["enabled"] is False
    assert cleared["source"] == "environment"


def test_deferred_tool_loading_is_default_on_with_environment_kill_switch(tmp_path: Path):
    default_registry = FeatureFlagRegistry(
        state_path=tmp_path / "default.json",
        environ={},
    )
    disabled_registry = FeatureFlagRegistry(
        state_path=tmp_path / "disabled.json",
        environ={"ARFORGE_FEATURE_DEFERRED_TOOL_LOADING": "0"},
    )

    assert default_registry.get("deferred_tool_loading")["enabled"] is True
    disabled = disabled_registry.get("deferred_tool_loading")
    assert disabled["enabled"] is False
    assert disabled["source"] == "environment"


def test_invalid_local_and_environment_values_are_reported_without_enabling(tmp_path: Path):
    state_path = tmp_path / "feature_flags.json"
    state_path.write_text('{"overrides":{"file_history":"yes","unknown":true}}', encoding="utf-8")
    registry = FeatureFlagRegistry(state_path=state_path, environ={"ARFORGE_FEATURE_FILE_HISTORY": "maybe"})

    result = registry.list()
    file_history = next(item for item in result["items"] if item["flag_id"] == "file_history")

    assert file_history["enabled"] is True
    assert file_history["source"] == "default"
    assert "non-boolean local override ignored: file_history" in result["problems"]
    assert "unknown local override ignored: unknown" in result["problems"]
    assert "invalid environment override ignored: ARFORGE_FEATURE_FILE_HISTORY" in result["problems"]


def test_bridge_list_is_native_but_mutation_still_enforced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    registry = FeatureFlagRegistry(state_path=tmp_path / "state" / "feature_flags.json")
    monkeypatch.setattr(feature_flags_module, "get_feature_flags", lambda: registry)
    monkeypatch.setattr(bridge_module, "get_feature_flags", lambda: registry)
    runtime = SessionRuntime(lambda _event: None, agent_factory=NoopAgent)
    actions = ActionRuntime(tmp_path)
    session_id = runtime.create_session()["session_id"]
    (tmp_path / "note.txt").write_text("before\n", encoding="utf-8")
    actions.preview_diff(session_id, "note.txt", "after\n")

    listed = dispatch({"version": "1.2", "method": "features.list", "params": {}})
    updated = dispatch(
        {
            "version": "1.2",
            "method": "features.set",
            "params": {"flag_id": "file_history", "enabled": False},
        }
    )
    blocked = dispatch(
        {
            "version": "1.2",
            "method": "file.history",
            "params": {"session_id": session_id, "file_path": "note.txt"},
        },
        runtime=runtime,
        actions=actions,
    )

    assert listed["ok"] is False
    assert listed["error"]["code"] == "METHOD_NOT_FOUND"
    assert updated["ok"] is True
    assert updated["data"]["enabled"] is False
    assert blocked["ok"] is False
    assert blocked["error"]["code"] == "FEATURE_DISABLED"
