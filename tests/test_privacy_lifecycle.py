"""Product tests for local data inventory, retention, and deletion."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os

from arforge.privacy_cli import clear_local_data, data_inventory, privacy_audit, prune_logs, scan_sensitive_files
from arforge.security_guard import (
    has_privacy_consent,
    record_privacy_consent,
    sanitize_for_storage,
)


def test_inventory_reads_metadata_only(tmp_path):
    (tmp_path / ".env").write_text("SECRET=value", encoding="utf-8")
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "arforge.log").write_text("safe", encoding="utf-8")

    result = data_inventory(tmp_path)

    assert result["files"] == 2
    assert result["credentials_present"] is True
    assert result["logs_bytes"] == 4


def test_prune_logs_only_removes_expired_logs(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    old = logs / "old.log"
    recent = logs / "recent.log"
    old.write_text("old", encoding="utf-8")
    recent.write_text("recent", encoding="utf-8")
    now = datetime.now(timezone.utc)
    old_time = (now - timedelta(days=31)).timestamp()
    os.utime(old, (old_time, old_time))

    result = prune_logs(30, tmp_path, now)

    assert result["files"] == 1
    assert not old.exists()
    assert recent.exists()


def test_clear_data_dry_run_changes_nothing(tmp_path):
    (tmp_path / "tasks.json").write_text("[]", encoding="utf-8")

    result = clear_local_data(home=tmp_path, dry_run=True)

    assert result["success"]
    assert (tmp_path / "tasks.json").exists()


def test_clear_data_preserves_credentials_by_default(tmp_path):
    (tmp_path / ".env").write_text("SECRET=value", encoding="utf-8")
    (tmp_path / "tasks.json").write_text("[]", encoding="utf-8")

    result = clear_local_data(home=tmp_path, dry_run=False, confirm=lambda *_: True)

    assert result["success"]
    assert (tmp_path / ".env").exists()
    assert not (tmp_path / "tasks.json").exists()


def test_clear_data_fails_closed_when_denied(tmp_path):
    target = tmp_path / "memory.db"
    target.write_text("data", encoding="utf-8")

    result = clear_local_data(home=tmp_path, dry_run=False, confirm=lambda *_: False)

    assert result["success"] is False
    assert target.exists()


def test_consent_respects_isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(home))

    assert has_privacy_consent() is False
    record_privacy_consent()

    assert has_privacy_consent() is True
    assert (home / "privacy_consent.json").exists()


def test_privacy_audit_uses_only_active_profile(tmp_path, monkeypatch):
    home = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(home))

    audit = privacy_audit()

    assert audit["arforge_home"] == str(home)
    assert audit["arforge_home_exists"] is False


def test_storage_sanitizer_removes_complete_credentials():
    secret = "sk-" + "A" * 38
    value = {"message": f"use {secret}", "token": "private-value"}

    cleaned = sanitize_for_storage(value)

    assert secret not in cleaned["message"]
    assert cleaned["token"] == "[REDACTED_SECRET]"


def test_sensitive_file_scan_reports_counts_not_values(tmp_path):
    secret = "sk-" + "B" * 38
    second = "sk-" + "token_with_underscore_123456789"
    (tmp_path / "memory.db").write_bytes(f"before {secret} {second} after".encode())
    (tmp_path / ".env").write_text(f"API_KEY={secret}", encoding="utf-8")

    result = scan_sensitive_files(tmp_path)

    assert result["findings"] == [{"path": "memory.db", "categories": {"openai_style": 2}}]
    assert secret not in str(result)


def test_memory_persistence_redacts_secrets():
    from arforge.memory import query_memories, save_memory_v2

    secret = "sk-" + "C" * 38
    memory_id = save_memory_v2(f"credential {secret}", dedupe=False)

    stored = next(item for item in query_memories(limit=10) if item["id"] == memory_id)
    assert secret not in stored["content"]
    assert "[REDACTED_SECRET]" in stored["content"]


def test_export_includes_redacted_persisted_conversations(tmp_path, monkeypatch):
    from arforge.export_cli import export_data
    from arforge.product.state_store import BridgeStateStore

    home = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(home))
    store = BridgeStateStore(home / "state" / "bridge_state.db")
    project = store.ensure_project(tmp_path / "workspace")
    store.save_session({
        "session_id": "session-1", "project_id": project["project_id"],
        "title": "导出测试", "status": "active", "created_at": "now", "updated_at": "now",
    })
    secret = "sk-" + "D" * 38
    store.save_message("session-1", "user", f"credential {secret}")

    exported = export_data()

    assert exported["conversations"]["projects"][0]["name"] == "workspace"
    assert exported["conversations"]["sessions"][0]["title"] == "导出测试"
    message = exported["conversations"]["messages"][0]["content"]
    assert secret not in message
    assert "[REDACTED_SECRET]" in message
