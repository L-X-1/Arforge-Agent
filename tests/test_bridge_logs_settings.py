from __future__ import annotations

import json
from pathlib import Path

import pytest

from arforge.bridge import dispatch
from arforge.logger import write_log
from arforge.product.log_runtime import LogRuntime, LogRuntimeError
from arforge.product.session_runtime import SessionRuntime
from arforge.product.settings_runtime import SettingsRuntime, SettingsRuntimeError


class NoopAgent:
    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, _value: str):
        return iter(())


def _settings(tmp_path: Path) -> SettingsRuntime:
    return SettingsRuntime(tmp_path / "settings.json", tmp_path / ".arforge_lang")


def test_log_query_pages_newest_first_without_duplicates(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    for number in range(5):
        write_log("info", f"message-{number}", event_id=f"event-{number}")
    logs = LogRuntime(tmp_path / "logs" / "arforge.log")

    first = logs.query(limit=2)
    second = logs.query(limit=2, cursor=first["next_cursor"])
    third = logs.query(limit=2, cursor=second["next_cursor"])

    messages = [item["message"] for page in (first, second, third) for item in page["items"]]
    assert messages == ["message-4", "message-3", "message-2", "message-1", "message-0"]
    assert len(messages) == len(set(messages))
    assert first["has_more"] is True
    assert third["has_more"] is False


def test_log_query_filters_and_redacts_untrusted_existing_lines(tmp_path: Path):
    secret = "sk-" + "Q" * 38
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    lines = [
        "not-json",
        json.dumps({"timestamp": "t1", "level": "INFO", "event_id": "1", "message": f"use {secret}"}),
        json.dumps({"timestamp": "t2", "level": "ERROR", "event_id": "2", "message": "failed", "context": {"token": secret}}),
    ]
    (log_dir / "arforge.log").write_text("\n".join(lines) + "\n", encoding="utf-8")

    result = LogRuntime(log_dir / "arforge.log").query(limit=10, levels=["ERROR"])
    rendered = json.dumps(result)

    assert result["count"] == 1
    assert result["items"][0]["level"] == "ERROR"
    assert result["items"][0]["context"]["token"] == "[REDACTED]"
    assert secret not in rendered
    assert result["skipped"] == 2


def test_log_query_rejects_forged_or_stale_cursor(tmp_path: Path):
    log_file = tmp_path / "arforge.log"
    log_file.write_text('{"level":"INFO","message":"one"}\n', encoding="utf-8")
    logs = LogRuntime(log_file)

    with pytest.raises(LogRuntimeError) as invalid:
        logs.query(cursor="not-a-cursor!")
    assert invalid.value.code == "INVALID_CURSOR"

    stale = logs._encode_cursor(log_file.stat().st_size + 100)
    with pytest.raises(LogRuntimeError) as expired:
        logs.query(cursor=stale)
    assert expired.value.code == "CURSOR_EXPIRED"


def test_log_query_response_is_bounded_below_bridge_request_limit(tmp_path: Path):
    log_file = tmp_path / "arforge.log"
    record = json.dumps(
        {
            "level": "INFO",
            "message": "m" * 10_000,
            "context": {"value": "c" * 10_000},
        }
    )
    log_file.write_text((record + "\n") * 200, encoding="utf-8")

    result = LogRuntime(log_file).query(limit=200)

    assert result["count"] == 200
    assert len(json.dumps(result).encode("utf-8")) < 1024 * 1024
    assert all(item["context"] == {"truncated": True} for item in result["items"])


def test_settings_update_is_allowlisted_revisioned_and_atomic(tmp_path: Path):
    settings = _settings(tmp_path)
    initial = settings.get()

    updated = settings.update(
        {"language": "en", "theme": "dark", "log_retention_days": 14, "chat_timeout_ms": 0},
        initial["revision"],
    )

    assert updated["revision"] == 1
    assert {key: updated["settings"][key] for key in ("language", "theme", "log_retention_days", "chat_timeout_ms")} == {
        "language": "en",
        "theme": "dark",
        "log_retention_days": 14,
        "chat_timeout_ms": 0,
    }
    assert updated["settings"]["terminal_position"] == "bottom"
    assert updated["settings"]["branch_prefix"] == "arforge/"
    assert json.loads((tmp_path / ".arforge_lang").read_text(encoding="utf-8")) == {"lang": "en"}
    assert not list(tmp_path.glob("*.tmp"))
    assert not (tmp_path / "settings.json.lock").exists()

    with pytest.raises(SettingsRuntimeError) as conflict:
        settings.update({"theme": "light"}, 0)
    assert conflict.value.code == "REVISION_CONFLICT"


@pytest.mark.parametrize("key", ["api_key", "database_url", "ARFORGE_AUTO_APPROVE", "access_token"])
def test_settings_reject_sensitive_fields(tmp_path: Path, key: str):
    with pytest.raises(SettingsRuntimeError) as caught:
        _settings(tmp_path).update({key: "secret"}, 0)
    assert caught.value.code == "SENSITIVE_SETTING"
    assert not (tmp_path / "settings.json").exists()


def test_desktop_git_terminal_worktree_and_appearance_preferences_are_persisted(tmp_path: Path):
    settings = _settings(tmp_path)

    updated = settings.update({
        "file_open_target": "vscode",
        "integrated_shell": "powershell",
        "terminal_position": "right",
        "show_bottom_panel": False,
        "branch_prefix": "team/feature",
        "pr_merge_method": "rebase",
        "allow_force_push": True,
        "draft_pull_requests": True,
        "auto_delete_worktrees": False,
        "worktree_retention_limit": 25,
        "accent_color": "#AABBCC",
        "translucent_sidebar": True,
        "custom_theme": "ember",
    }, 0)

    assert updated["settings"] == settings.get()["settings"]
    assert updated["settings"]["branch_prefix"] == "team/feature/"
    assert updated["settings"]["accent_color"] == "#aabbcc"
    assert updated["settings"]["terminal_position"] == "right"
    assert updated["settings"]["custom_theme"] == "ember"


@pytest.mark.parametrize("changes", [
    {"branch_prefix": "../escape"},
    {"branch_prefix": "/absolute"},
    {"terminal_position": "floating"},
    {"worktree_retention_limit": 101},
    {"accent_color": "red"},
    {"custom_theme": "../unsafe"},
])
def test_desktop_preferences_reject_invalid_values(tmp_path: Path, changes: dict):
    with pytest.raises(SettingsRuntimeError) as error:
        _settings(tmp_path).update(changes, 0)

    assert error.value.code == "INVALID_SETTING_VALUE"


def test_settings_corruption_fails_closed_without_overwrite(tmp_path: Path):
    path = tmp_path / "settings.json"
    path.write_text('{"schema_version":1,"revision":0,"settings":{"language":"invalid"}}', encoding="utf-8")
    original = path.read_bytes()

    with pytest.raises(SettingsRuntimeError) as caught:
        _settings(tmp_path).get()

    assert caught.value.code == "SETTINGS_CORRUPT"
    assert path.read_bytes() == original


def test_settings_recovers_stale_update_lock(tmp_path: Path):
    import os
    import time

    settings = _settings(tmp_path)
    lock = tmp_path / "settings.json.lock"
    lock.write_text("stale", encoding="utf-8")
    stale = time.time() - 60
    os.utime(lock, (stale, stale))

    updated = settings.update({"theme": "light"}, 0)

    assert updated["settings"]["theme"] == "light"
    assert not lock.exists()


def test_i18n_and_settings_share_one_language_authority(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    from arforge.i18n import get_active_lang, set_active_lang

    assert set_active_lang("en") == "en"
    assert get_active_lang() == "en"
    stored = _settings(tmp_path).get()
    assert stored["settings"]["language"] == "en"


def test_cli_log_prune_uses_settings_default(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    _settings(tmp_path).update({"log_retention_days": 7}, 0)
    observed: list[int] = []

    def fake_prune(days: int):
        observed.append(days)
        return {"files": 0, "bytes": 0}

    monkeypatch.setattr("arforge.privacy_cli.prune_logs", fake_prune)
    from arforge.cli import _run_logs_prune

    assert _run_logs_prune([]) == 0
    assert observed == [7]


def test_bridge_settings_disable_default_chat_timeout_and_advertise_contract(tmp_path: Path):
    settings = _settings(tmp_path)
    settings.update({"chat_timeout_ms": 0}, 0)
    runtime = SessionRuntime(lambda _event: None, agent_factory=NoopAgent)
    session_id = runtime.create_session()["session_id"]

    response = dispatch(
        {
            "version": "1.1",
            "method": "chat.start",
            "params": {"session_id": session_id, "input": "hello"},
        },
        runtime=runtime,
        settings=settings,
    )
    described = dispatch({"version": "1.1", "method": "protocol.describe"})

    assert response["data"]["timeout_ms"] == 0
    assert "logs.query" in described["data"]["methods"]
    assert "settings.get" in described["data"]["methods"]
    assert "settings.update" in described["data"]["mutating_methods"]
    runtime.cancel_operation(response["data"]["operation_id"])
    runtime.release_operation(response["data"]["operation_id"])


def test_legacy_persisted_chat_timeout_migrates_to_disabled(tmp_path: Path):
    import json

    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps({
            "schema_version": 1,
            "revision": 7,
            "updated_at": None,
            "settings": {
                "language": "zh",
                "theme": "system",
                "log_retention_days": 30,
                "chat_timeout_ms": 120_000,
            },
        }),
        encoding="utf-8",
    )

    loaded = SettingsRuntime(path).get()

    assert loaded["revision"] == 7
    assert loaded["settings"]["chat_timeout_ms"] == 0


def test_bridge_log_and_settings_errors_have_stable_codes(tmp_path: Path):
    logs = LogRuntime(tmp_path / "arforge.log")
    settings = _settings(tmp_path)
    bad_log = dispatch(
        {"version": "1.1", "method": "logs.query", "params": {"limit": 0}},
        logs=logs,
        settings=settings,
    )
    bad_setting = dispatch(
        {
            "version": "1.1",
            "method": "settings.update",
            "params": {"changes": {"api_key": "secret"}, "expected_revision": 0},
        },
        logs=logs,
        settings=settings,
    )

    assert bad_log["error"]["code"] == "INVALID_PARAMS"
    assert bad_setting["error"]["code"] == "SENSITIVE_SETTING"
    assert "secret" not in json.dumps(bad_setting)
