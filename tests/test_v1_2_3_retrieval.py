"""v1-2.3 检索质量评估（retrieval_eval）测试。"""

from __future__ import annotations

from arforge.core.retrieval_eval import (
    RetrievalTask,
    arforge_source_root,
    builtin_retrieval_tasks,
    run_retrieval_eval,
    search_files,
)


def test_search_finds_known_symbol():
    files = search_files("DENY_ARG_PATTERNS", arforge_source_root())
    assert any("basic_tools.py" in f for f in files)


def test_search_misses_nonexistent():
    files = search_files("zzz_totally_nonexistent_symbol_xyz", arforge_source_root())
    assert files == []


def test_builtin_retrieval_hit_rate_baseline():
    report = run_retrieval_eval(builtin_retrieval_tasks(), arforge_source_root())
    assert report.total == 10
    # 检索质量基线：金标准查询应几乎全部命中（锁定，防未来检索退化）。
    assert report.hit_rate >= 0.9, [c.query for c in report.cases if not c.hit]


def test_retrieval_miss_yields_zero():
    report = run_retrieval_eval(
        [RetrievalTask("zzz_nonexistent_xyz", ["nope.py"])], arforge_source_root()
    )
    assert report.hit_rate == 0.0


def test_report_to_dict_structure():
    report = run_retrieval_eval(builtin_retrieval_tasks(), arforge_source_root())
    d = report.to_dict()
    assert set(d) >= {"total", "hits", "hit_rate", "cases"}
    assert len(d["cases"]) == 10


def test_custom_search_fn_injectable():
    tasks = [RetrievalTask("q", ["target.py"])]
    report = run_retrieval_eval(tasks, ".", search_fn=lambda q, root: ["a/target.py"])
    assert report.hit_rate == 1.0
