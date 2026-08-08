"""Long-term memory categorized digest tests."""

from __future__ import annotations


def _seed_memories() -> dict:
    from arforge.memory_os import MemoryOS

    memory_os = MemoryOS()
    created = {}
    for mem_type, content in (
        ("identity", "我的名字是小明，是一名 Python 后端工程师"),
        ("identity", "我负责 Arforge 项目的数据库模块"),
        ("preference", "回答时使用中文，代码使用 4 空格缩进"),
        ("preference", "测试统一使用 pytest"),
        ("convention", "本项目提交信息必须使用 Conventional Commits"),
        ("workflow", "发布流程：先跑全量测试，再构建，最后签名"),
        ("constraint", "不要直接修改生产数据库"),
        ("fact", "Arforge 当前版本是 0.9.0"),
        ("error", "常见错误：pytest 收集不到测试时检查 conftest"),
        ("project", "Arforge 是本地优先的编码 Agent"),
    ):
        record = memory_os.create(content, mem_type=mem_type)
        created[mem_type] = record["id"]
    return created


def test_digest_report_groups_by_category_with_counts():
    from arforge.core.memory_digest import digest_report

    _seed_memories()
    report = digest_report()

    assert report["total"] == 10
    assert report["category_count"] >= 6
    by_category = {entry["category"]: entry for entry in report["categories"]}
    assert by_category["identity"]["count"] == 2
    assert by_category["identity"]["label"] == "用户身份信息"
    assert by_category["preference"]["count"] == 2
    items = by_category["identity"]["items"]
    assert items[0]["importance"] >= items[1]["importance"]


def test_digest_report_category_filter():
    from arforge.core.memory_digest import digest_report

    _seed_memories()
    report = digest_report(category_filter="identity")

    assert report["total"] == 2
    assert len(report["categories"]) == 1
    assert report["categories"][0]["category"] == "identity"


def test_render_markdown_includes_all_categories_and_entries():
    from arforge.core.memory_digest import render_markdown

    _seed_memories()
    document = render_markdown(
        {
            "identity": [{"content": "我叫小明", "importance": 2, "source": "user", "created_at": "2026-01-01T00:00:00Z"}],
            "preference": [{"content": "用中文回答", "importance": 3, "source": "auto"}],
        }
    )

    assert "用户身份信息" in document
    assert "偏好与习惯" in document
    assert "我叫小明" in document
    assert "用中文回答" in document
    assert "类别概览" in document
    assert "共 2 条长期记忆" in document


def test_render_markdown_category_filter():
    from arforge.core.memory_digest import render_markdown

    groups = {
        "identity": [{"content": "我叫小明", "importance": 2}],
        "preference": [{"content": "用中文", "importance": 3}],
    }
    document = render_markdown(groups, category_filter="identity")

    assert "我叫小明" in document
    assert "用中文" not in document


def test_unknown_mem_type_falls_back_to_knowledge():
    from arforge.core.memory_digest import group_by_category

    groups = group_by_category([{"content": "任意知识", "mem_type": "weird_kind"}])

    assert groups["knowledge"][0]["content"] == "任意知识"


def test_write_digest_markdown_writes_file(tmp_path):
    from arforge.core.memory_digest import write_digest_markdown

    _seed_memories()
    target = str(tmp_path / "memory-digest.md")
    path = write_digest_markdown(target)

    assert path == target
    text = tmp_path.joinpath("memory-digest.md").read_text(encoding="utf-8")
    assert "用户身份信息" in text
    assert "我的名字是小明" in text


def test_digest_report_empty_store_is_safe():
    from arforge.core.memory_digest import digest_report

    report = digest_report()

    assert report["total"] == 0
    assert report["categories"] == []


def test_save_memory_v2_auto_refreshes_digest_file(tmp_path):
    from pathlib import Path

    from arforge.core.memory_digest import _reset_refresh_throttle
    from arforge.memory import save_memory_v2

    _reset_refresh_throttle()
    save_memory_v2("我的名字是自动刷新测试用户", mem_type="identity")

    digest_file = Path(tmp_path) / ".arforge" / "memory-digest.md"
    assert digest_file.is_file()
    text = digest_file.read_text(encoding="utf-8")
    assert "我的名字是自动刷新测试用户" in text
    assert "用户身份信息" in text


def test_refresh_is_throttled_but_force_refreshes(tmp_path):
    from pathlib import Path

    from arforge.core.memory_digest import (
        _reset_refresh_throttle,
        default_digest_path,
        refresh_digest_file,
    )
    from arforge.memory import save_memory_v2

    _reset_refresh_throttle()
    save_memory_v2("第一条节流记忆", mem_type="fact")
    first = Path(default_digest_path())
    assert first.is_file()

    second = refresh_digest_file()
    assert second is None

    save_memory_v2("第二条强制刷新记忆", mem_type="fact")
    forced = refresh_digest_file(force=True)
    assert forced is not None
    text = first.read_text(encoding="utf-8")
    assert "第二条强制刷新记忆" in text


def test_service_delete_refreshes_digest(tmp_path):
    from pathlib import Path

    from arforge.core.memory_digest import _reset_refresh_throttle
    from arforge.memory import save_memory_v2
    from arforge.product.service import ProductService

    _reset_refresh_throttle()
    memory_id = save_memory_v2("待删除的整理记忆", mem_type="preference")
    digest_file = Path(tmp_path) / ".arforge" / "memory-digest.md"
    assert digest_file.is_file()
    assert "待删除的整理记忆" in digest_file.read_text(encoding="utf-8")

    _reset_refresh_throttle()
    ProductService().memory_delete({"memory_id": memory_id})

    text = digest_file.read_text(encoding="utf-8")
    assert "待删除的整理记忆" not in text
