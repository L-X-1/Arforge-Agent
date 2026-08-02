"""External file-write runtime: preview does not touch disk, apply writes for real,
and risky targets require approval or are rejected outright."""

from __future__ import annotations

import os

from arforge.product.action_runtime import ActionRuntime, ActionRuntimeError
from arforge.product.state_store import BridgeStateStore


def _runtime(tmp_path, monkeypatch):
    store = BridgeStateStore(tmp_path / "state.db")
    # Redirect HOME so "Desktop" resolves under an isolated fake home that lives
    # OUTSIDE the workspace root (otherwise the path resolves as workspace-internal
    # and gets the low risk tier).
    fake_home = tmp_path.parent / "fake_home"
    (fake_home / "Desktop").mkdir(parents=True, exist_ok=True)
    (fake_home / "Documents").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setattr(os.path, "expanduser", lambda path: path.replace("~", str(fake_home)))
    monkeypatch.setattr(os.path, "expandvars", lambda path: path.replace("%USERPROFILE%", str(fake_home)))
    return ActionRuntime(tmp_path, lambda _event: None, store=store), fake_home


def test_preview_does_not_write_to_disk(tmp_path, monkeypatch):
    runtime, home = _runtime(tmp_path, monkeypatch)
    target = home / "Desktop" / "summary.txt"
    preview = runtime.preview_file_write(
        "s1", str(target), "today's summary", overwrite=False,
    )
    assert preview["status"] == "previewed"
    assert preview["preview"]["size_bytes"] == len("today's summary")
    assert preview["approval_id"]
    assert preview["risk"] == "medium"  # Desktop new file
    # Nothing written yet.
    assert not target.exists()


def test_apply_creates_the_file_for_real_after_approval(tmp_path, monkeypatch):
    runtime, home = _runtime(tmp_path, monkeypatch)
    target = home / "Desktop" / "summary.txt"
    preview = runtime.preview_file_write("s1", str(target), "今天的总结内容", overwrite=False)
    approval_id = preview["approval_id"]

    runtime.respond_approval("s1", approval_id, "approve")
    applied = runtime.apply_file_write("s1", preview["artifact_id"], approval_id)

    assert applied["status"] == "applied"
    assert applied["artifact"]["path"] == str(target)
    assert applied["artifact"]["size_bytes"] == len("今天的总结内容".encode("utf-8"))
    # The file really exists with the right content.
    assert target.read_text(encoding="utf-8") == "今天的总结内容"


def test_apply_requires_an_approval_first(tmp_path, monkeypatch):
    runtime, home = _runtime(tmp_path, monkeypatch)
    preview = runtime.preview_file_write("s1", str(home / "Desktop" / "x.txt"), "data")
    with __import__("pytest").raises(ActionRuntimeError) as exc:
        runtime.apply_file_write("s1", preview["artifact_id"], preview["approval_id"])
    assert exc.value.code == "APPROVAL_REQUIRED"
    assert not (home / "Desktop" / "x.txt").exists()


def test_existing_file_is_not_overwritten_without_overwrite_flag(tmp_path, monkeypatch):
    runtime, home = _runtime(tmp_path, monkeypatch)
    target = home / "Desktop" / "exists.txt"
    target.write_text("original", encoding="utf-8")
    with __import__("pytest").raises(ActionRuntimeError) as exc:
        runtime.preview_file_write("s1", str(target), "new", overwrite=False)
    assert exc.value.code == "FILE_EXISTS"
    # Untouched.
    assert target.read_text(encoding="utf-8") == "original"


def test_system_and_executable_paths_are_rejected(tmp_path, monkeypatch):
    runtime, _home = _runtime(tmp_path, monkeypatch)
    with __import__("pytest").raises(ActionRuntimeError) as exc:
        runtime.preview_file_write("s1", "C:\\Windows\\System32\\evil.txt", "x")
    assert exc.value.code == "PROTECTED_PATH"
    with __import__("pytest").raises(ActionRuntimeError) as exc:
        runtime.preview_file_write("s1", str(_home / "Desktop" / "malware.exe"), "x")
    assert exc.value.code == "PROTECTED_PATH"
    with __import__("pytest").raises(ActionRuntimeError) as exc:
        runtime.preview_file_write("s1", str(_home / "Desktop" / "script.bat"), "x")
    assert exc.value.code == "PROTECTED_PATH"


def test_workspace_internal_write_is_low_risk(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    monkeypatch.setattr(os.path, "expanduser", lambda path: str(tmp_path / "home"))
    monkeypatch.setattr(os.path, "expandvars", lambda path: path)
    runtime = ActionRuntime(tmp_path, lambda _event: None)
    target = tmp_path / "notes.txt"
    preview = runtime.preview_file_write("s1", str(target), "workspace note")
    assert preview["risk"] == "low"


def test_rejected_approval_blocks_apply(tmp_path, monkeypatch):
    runtime, home = _runtime(tmp_path, monkeypatch)
    target = home / "Desktop" / "blocked.txt"
    preview = runtime.preview_file_write("s1", str(target), "data")
    runtime.respond_approval("s1", preview["approval_id"], "reject")
    with __import__("pytest").raises(ActionRuntimeError) as exc:
        runtime.apply_file_write("s1", preview["artifact_id"], preview["approval_id"])
    assert exc.value.code == "APPROVAL_REQUIRED"
    assert not target.exists()


def test_file_write_shows_up_in_action_list(tmp_path, monkeypatch):
    runtime, home = _runtime(tmp_path, monkeypatch)
    preview = runtime.preview_file_write("s1", str(home / "Desktop" / "list.txt"), "data")
    actions = runtime.list_actions("s1")
    assert actions["count"] == 1
    assert actions["items"][0]["kind"] == "file.write"
    assert actions["items"][0]["record_id"] == preview["artifact_id"]
