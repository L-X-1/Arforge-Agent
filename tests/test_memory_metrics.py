"""记忆检索金标准评测模块（arforge.memory_metrics）的测试."""

from __future__ import annotations

import os

from arforge.database import Memory, get_session
from arforge.memory_metrics import (
    GOLDEN_DECOYS,
    GOLDEN_FIXTURES,
    GOLDEN_WORKSPACE,
    MemoryGoldenCase,
    builtin_memory_golden_suite,
    memory_metrics_history,
    memory_metrics_report,
    run_memory_golden_eval,
    source_coverage_report,
)
from arforge.memory_os import MemoryOS

_STRONG_CASES = (
    "中文偏好召回",
    "编码风格偏好",
    "提交前工作流，双相关项",
    "错误模式",
    "中文自然长句查询",
)


def _case_by_description(report: dict, description: str) -> dict:
    return next(case for case in report["cases"] if case["description"] == description)


def test_builtin_suite_shape():
    suite = builtin_memory_golden_suite()
    assert len(suite) >= 14
    for case in suite:
        assert case.query.strip()
        assert case.relevant_content
        assert case.workspace
        assert 1 <= case.top_k <= 20


def test_golden_suite_hits_at_one_for_strong_cases():
    report = run_memory_golden_eval()
    assert report["schema_version"] == 1
    assert report["algorithm"] == "golden_memory_retrieval"
    assert report["is_isolated"] is True
    assert report["fixture_count"] == len(GOLDEN_FIXTURES) + len(GOLDEN_DECOYS)
    assert report["case_count"] == len(builtin_memory_golden_suite())
    for description in _STRONG_CASES:
        case = _case_by_description(report, description)
        assert case["hit_at_1"] is True, case
        assert case["first_relevant_rank"] == 1
        assert case["mrr"] == 1.0


def test_golden_suite_recall_and_precision_baselines():
    report = run_memory_golden_eval()
    assert report["mean_recall_at_1"] >= 0.8
    assert report["mean_recall_at_5"] >= 0.9
    assert report["mean_recall_at_10"] >= 0.9
    assert report["mean_precision_at_1"] >= 0.8
    assert report["mean_mrr"] >= 0.8
    assert report["hit_rate_at_1"] >= 0.8
    assert report["mean_precision_at_5"] >= 0.2
    for case in report["cases"]:
        assert isinstance(case["returned_ids"], list)
        assert isinstance(case["missing_relevant"], list)


def test_decoy_does_not_wreck_top_one_precision():
    report = run_memory_golden_eval()
    for case in report["cases"]:
        top1 = case["returned_ids"][:1]
        assert case["precision_at_1"] == (1.0 if top1 else 0.0)
    assert report["mean_precision_at_1"] >= 0.8


def test_custom_suite_accepted():
    suite = [
        MemoryGoldenCase(
            query="回答问题时应该使用什么语言？",
            relevant_content=["用户偏好使用简体中文回答所有问题"],
            description="自定义用例",
        )
    ]
    report = run_memory_golden_eval(suite=suite)
    assert report["case_count"] == 1
    assert report["cases"][0]["hit_at_1"] is True
    assert report["fixture_count"] == len(GOLDEN_FIXTURES) + len(GOLDEN_DECOYS)


def test_eval_switches_env_to_inmemory_during_run(tmp_path, monkeypatch):
    db_url = f"sqlite:///{tmp_path / 'real.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", db_url)
    from arforge.database.engine import dispose_engines

    dispose_engines()
    observed_urls: list[str] = []
    original_recall = MemoryOS.recall

    def capturing_recall(self, query: str, **kwargs):
        observed_urls.append(os.environ.get("ARFORGE_DB_URL"))
        return original_recall(self, query, **kwargs)

    monkeypatch.setattr(MemoryOS, "recall", capturing_recall)
    report = run_memory_golden_eval()
    assert observed_urls
    assert all(url == "sqlite:///:memory:" for url in observed_urls)
    assert os.environ["ARFORGE_DB_URL"] == db_url
    assert report["is_isolated"] is True


def test_eval_fixtures_never_leak_into_real_database(tmp_path, monkeypatch):
    db_url = f"sqlite:///{tmp_path / 'real.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", db_url)
    from arforge.database.engine import dispose_engines, get_engine

    dispose_engines()
    get_engine()
    sentinel = "哨兵记忆：只属于真实库"
    MemoryOS().create(
        sentinel,
        importance=1,
        project_id="golden-eval",
        workspace_path=GOLDEN_WORKSPACE,
    )

    run_memory_golden_eval()
    assert os.environ["ARFORGE_DB_URL"] == db_url

    dispose_engines()
    with get_session() as session:
        sentinel_count = session.query(Memory).filter(Memory.content == sentinel).count()
        leaked = session.query(Memory).filter(Memory.content == GOLDEN_FIXTURES[0]["content"]).count()
    assert sentinel_count == 1
    assert leaked == 0


def test_eval_restores_missing_db_url_env(monkeypatch):
    monkeypatch.delenv("ARFORGE_DB_URL", raising=False)
    run_memory_golden_eval()
    assert os.environ.get("ARFORGE_DB_URL") is None


def test_source_coverage_report_counts_traceable_memories():
    MemoryOS().create(
        "带认知溯源的记忆",
        provenance={
            "kind": "cognitive_promotion",
            "source_run_id": "run-abc",
            "signal_record_id": "sig-1",
        },
        source="runtime",
    )
    MemoryOS().create(
        "带证据链的记忆",
        provenance={"evidence_ids": ["e1", "e2"]},
        source="auto",
    )
    MemoryOS().create(
        "纯用户记忆无溯源",
        source="user",
    )
    report = source_coverage_report()
    assert report["active_total"] == 3
    assert report["traceable"] == 2
    assert report["source_coverage_rate"] == 0.6667
    by_source = {entry["source"]: entry["count"] for entry in report["by_source"]}
    assert by_source == {"auto": 1, "runtime": 1, "user": 1}
    assert len(report["untraceable_samples"]) == 1
    assert report["untraceable_samples"][0]["content"] == "纯用户记忆无溯源"
    assert any(entry["kind"] == "cognitive_promotion" for entry in report["by_provenance_kind"])


def test_metrics_history_reads_recent_records():
    run_memory_golden_eval()
    history = memory_metrics_history(limit=5)
    assert history
    latest = history[-1]
    assert latest["timestamp"]
    assert latest["algorithm"] == "golden_memory_retrieval"
    assert latest["is_isolated"] is True
    assert isinstance(latest["mean_recall_at_5"], float)
    assert isinstance(latest["hit_rate_at_1"], float)


def test_metrics_history_empty_without_file(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "empty"))
    assert memory_metrics_history() == []


def test_memory_metrics_report_combines_sources():
    run_memory_golden_eval()
    report = memory_metrics_report()
    assert report["golden_eval"]["algorithm"] == "golden_memory_retrieval"
    assert "active_total" in report["source_coverage"]
    assert "recalls" in report["recall_quality"]
