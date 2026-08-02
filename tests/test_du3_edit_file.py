"""DU-3 精确 edit 工具 验收测试。

覆盖：唯一命中替换、未命中报错、多命中非 replace_all 报错、replace_all、
old==new 报错、越界路径被沙箱拒绝。
"""

import pytest

import arforge.tools.file_tools as ft
from arforge.tools.file_tools import edit_file


@pytest.fixture
def ws(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "WORKSPACE", tmp_path)
    monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")  # 允许 safe_write 确认
    return tmp_path


def test_edit_replaces_unique(ws):
    (ws / "a.py").write_text("x = 1\ny = 2\nz = 3\n", encoding="utf-8")
    out = edit_file("a.py", "y = 2", "y = 20")
    assert "edited a.py" in out
    assert (ws / "a.py").read_text(encoding="utf-8") == "x = 1\ny = 20\nz = 3\n"


def test_edit_missing_raises(ws):
    (ws / "a.py").write_text("x = 1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="not found"):
        edit_file("a.py", "nope", "y")


def test_edit_ambiguous_raises(ws):
    (ws / "a.py").write_text("dup\ndup\n", encoding="utf-8")
    with pytest.raises(ValueError, match="appears 2 times"):
        edit_file("a.py", "dup", "x")


def test_edit_replace_all(ws):
    (ws / "a.py").write_text("dup\ndup\n", encoding="utf-8")
    out = edit_file("a.py", "dup", "x", replace_all=True)
    assert (ws / "a.py").read_text(encoding="utf-8") == "x\nx\n"
    assert "2 replacements" in out


def test_edit_identical_raises(ws):
    (ws / "a.py").write_text("a\n", encoding="utf-8")
    with pytest.raises(ValueError, match="identical"):
        edit_file("a.py", "a", "a")


def test_edit_outside_workspace_blocked(ws):
    with pytest.raises(ValueError, match="escapes workspace"):
        edit_file("../outside.py", "a", "b")


def test_relative_traversal_stays_blocked_in_local_computer_mode(ws, monkeypatch):
    monkeypatch.setattr(ft, "_uses_local_computer_paths", lambda: True)
    with pytest.raises(ValueError, match="escapes workspace"):
        edit_file("../outside.py", "a", "b")
