from __future__ import annotations

import hashlib
import importlib
import sys

import pytest

from arforge.core.file_state import FileStateTracker, reset_file_state_tracker


@pytest.fixture
def file_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_WORKSPACE", str(tmp_path))
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
    reset_file_state_tracker()
    for mod in list(sys.modules):
        if mod.startswith("arforge.tools.file_tools") or mod.startswith("arforge.tools.code_tools"):
            del sys.modules[mod]
    import arforge.tools.file_tools as ft

    return importlib.reload(ft)


def test_file_state_tracker_records_hash_size_mtime_and_read_count(tmp_path):
    target = tmp_path / "a.txt"
    target.write_text("alpha", encoding="utf-8")
    tracker = FileStateTracker()

    first = tracker.observe(target, content="alpha")
    second = tracker.observe(target, content="alpha")

    assert first.sha256 == hashlib.sha256(b"alpha").hexdigest()
    assert second.sha256 == first.sha256
    assert second.size_bytes == 5
    assert second.mtime_ns == target.stat().st_mtime_ns
    assert second.read_count == 2
    assert tracker.get(target) == second


def test_read_file_preserves_output_and_records_observation(file_tools, tmp_path):
    (tmp_path / "note.txt").write_text("hello\n", encoding="utf-8")

    output = file_tools.read_file("note.txt")
    state = file_tools.file_state("note.txt")

    assert output == "hello\n"
    assert state["observed"] is not None
    assert state["observed"]["sha256"] == state["current"]["sha256"]
    assert state["observed"]["read_count"] == 1
    assert state["changed_since_observed"] is False


def test_file_state_reports_missing_file_without_crashing(file_tools):
    state = file_tools.file_state("missing-tool.exe")

    assert state["exists"] is False
    assert state["current"] is None
    assert state["observed"] is None
    assert state["changed_since_observed"] is False


def test_read_file_if_changed_omits_content_when_hash_matches(file_tools, tmp_path):
    (tmp_path / "memo.md").write_text("same content", encoding="utf-8")
    first = file_tools.read_file_if_changed("memo.md")

    second = file_tools.read_file_if_changed("memo.md", first["current"]["sha256"])

    assert first["changed"] is True
    assert first["content"] == "same content"
    assert second["changed"] is False
    assert second["content"] is None
    assert second["current"]["sha256"] == first["current"]["sha256"]


def test_read_file_if_changed_reads_again_after_file_changes(file_tools, tmp_path):
    target = tmp_path / "memo.md"
    target.write_text("v1", encoding="utf-8")
    first = file_tools.read_file_if_changed("memo.md")

    target.write_text("v2", encoding="utf-8")
    second = file_tools.read_file_if_changed("memo.md", first["current"]["sha256"])

    assert second["changed"] is True
    assert second["content"] == "v2"
    assert second["current"]["sha256"] != first["current"]["sha256"]


def test_file_state_reports_change_since_observed(file_tools, tmp_path):
    target = tmp_path / "tracked.txt"
    target.write_text("before", encoding="utf-8")
    file_tools.read_file("tracked.txt")

    target.write_text("after", encoding="utf-8")
    state = file_tools.file_state("tracked.txt")

    assert state["observed"] is not None
    assert state["changed_since_observed"] is True
    assert state["observed"]["sha256"] != state["current"]["sha256"]


def test_file_state_tools_are_registered_as_read_only(file_tools):
    from arforge.tool_registry import REGISTRY

    names = {tool["function"]["name"] for tool in REGISTRY.to_openai_tools()}
    assert {"file_state", "read_file_if_changed"} <= names
    for name in ("file_state", "read_file_if_changed"):
        tool = REGISTRY.get(name)
        assert tool is not None
        assert tool.schema.category == "read"
        assert tool.schema.requires_confirmation is False


def test_code_read_records_file_state(file_tools, tmp_path):
    (tmp_path / "app.py").write_text("def run():\n    return 1\n", encoding="utf-8")
    import arforge.tools.code_tools as ct

    ct = importlib.reload(ct)
    output = ct.code_read("app.py")
    state = file_tools.file_state("app.py")

    assert "def run" in output
    assert state["observed"] is not None
    assert state["observed"]["read_count"] == 1
    assert state["changed_since_observed"] is False


def test_bridge_file_state_list_reports_stale_files(file_tools, tmp_path):
    from arforge.bridge import dispatch

    target = tmp_path / "app.py"
    target.write_text("def run():\n    return 1\n", encoding="utf-8")
    file_tools.read_file("app.py")
    target.write_text("def run():\n    return 2\n", encoding="utf-8")

    described = dispatch({"id": 1, "version": "1.1", "method": "protocol.describe"})
    response = dispatch({"id": 2, "version": "1.1", "method": "file_state.list", "params": {"limit": 10}})

    assert "file_state.list" in described["data"]["methods"]
    assert response["ok"] is True
    assert response["data"]["count"] == 1
    item = response["data"]["items"][0]
    assert item["changed_since_observed"] is True
    assert item["missing"] is False
    assert item["observed"]["sha256"] != item["current"]["sha256"]


def test_cli_file_state_lists_observed_files(file_tools, tmp_path, capsys):
    from arforge.cli import _run_file_state

    target = tmp_path / "note.txt"
    target.write_text("before", encoding="utf-8")
    file_tools.read_file("note.txt")

    assert _run_file_state() == 0
    output = capsys.readouterr().out
    assert "File State" in output
    assert "note.txt" in output
    assert "fresh" in output

    target.write_text("after", encoding="utf-8")
    assert _run_file_state() == 0
    output = capsys.readouterr().out
    assert "changed" in output
