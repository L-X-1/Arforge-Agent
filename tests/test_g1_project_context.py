"""G1 项目约定自动加载（discover_project_conventions）测试。"""

from __future__ import annotations

from arforge.core.project_context import discover_project_conventions


def test_no_conventions_returns_empty(tmp_path):
    assert discover_project_conventions(tmp_path) == ""


def test_finds_agents_md(tmp_path):
    (tmp_path / "AGENTS.md").write_text("用 4 空格缩进。", encoding="utf-8")
    out = discover_project_conventions(tmp_path)
    assert "本项目约定" in out
    assert "AGENTS.md" in out
    assert "4 空格缩进" in out


def test_finds_multiple(tmp_path):
    (tmp_path / "AGENTS.md").write_text("规矩A", encoding="utf-8")
    (tmp_path / ".arforgerules").write_text("规矩B", encoding="utf-8")
    out = discover_project_conventions(tmp_path)
    assert "规矩A" in out
    assert "规矩B" in out


def test_nearest_wins(tmp_path):
    child = tmp_path / "sub"
    child.mkdir()
    (tmp_path / "AGENTS.md").write_text("父级规矩", encoding="utf-8")
    (child / "AGENTS.md").write_text("子级规矩", encoding="utf-8")
    out = discover_project_conventions(child)
    assert "子级规矩" in out
    assert "父级规矩" not in out  # 就近优先：上层同名不再注入


def test_finds_in_parent(tmp_path):
    child = tmp_path / "sub"
    child.mkdir()
    (tmp_path / "AGENTS.md").write_text("父级规矩", encoding="utf-8")
    out = discover_project_conventions(child)
    assert "父级规矩" in out  # 向上逐级发现


def test_truncates_long(tmp_path):
    (tmp_path / "AGENTS.md").write_text("x" * 10000, encoding="utf-8")
    out = discover_project_conventions(tmp_path, max_chars=500)
    assert "已截断" in out
    assert len(out) < 2000


def test_empty_file_skipped(tmp_path):
    (tmp_path / "AGENTS.md").write_text("   \n  ", encoding="utf-8")
    assert discover_project_conventions(tmp_path) == ""


def test_max_levels_respected(tmp_path):
    deep = tmp_path / "a" / "b" / "c" / "d" / "e"
    deep.mkdir(parents=True)
    (tmp_path / "AGENTS.md").write_text("顶层规矩", encoding="utf-8")
    # 只看 deep 与其 1 层父级，找不到更上层的顶层规矩
    assert discover_project_conventions(deep, max_levels=2) == ""


def test_bad_start_dir_safe():
    # 不存在的路径不应抛异常
    assert discover_project_conventions("/no/such/dir/xyz") == ""
