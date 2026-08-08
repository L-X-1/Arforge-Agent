"""错误记忆写入率统计管道测试."""

from __future__ import annotations

import json
import os
from pathlib import Path

from arforge.auto_memory import extract_memories_from_turn
from arforge.memory_os import MemoryOS
from arforge.memory_writes import clear_write_metrics, memory_write_stats, record_write_decision


def _log_path() -> Path:
    return Path(os.environ["ARFORGE_HOME"]) / "memory_writes.jsonl"


def _read_log() -> list[dict]:
    if not _log_path().is_file():
        return []
    with _log_path().open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def test_record_write_decision_writes_hash_not_plaintext():
    secret = "SECRET-PHRASE-xyz-12345 双空格  测试"
    record_write_decision(
        content=secret,
        mem_type="preference",
        eligible=True,
        reason="durable_identity",
        source="rule",
        saved=True,
        workspace_path="C:/some/workspace",
    )

    raw = _log_path().read_text(encoding="utf-8")
    assert secret not in raw
    assert "SECRET-PHRASE" not in raw
    records = _read_log()
    assert len(records) == 1
    record = records[0]
    assert record["content_hash"].startswith("sha256:")
    assert len(record["content_hash"]) == 7 + 32
    assert record["mem_type"] == "preference"
    assert record["eligible"] is True
    assert record["reason"] == "durable_identity"
    assert record["source"] == "rule"
    assert record["saved"] is True
    assert record["ts"].endswith("Z")
    assert record["workspace_scope"] and len(record["workspace_scope"]) == 16


def test_record_write_decision_silent_on_io_error(monkeypatch, tmp_path):
    home_as_file = tmp_path / "home_as_file"
    home_as_file.write_text("not a directory", encoding="utf-8")
    monkeypatch.setenv("ARFORGE_HOME", str(home_as_file))

    record_write_decision(
        content="不可写目录下的内容",
        mem_type="knowledge",
        eligible=False,
        reason="missing_durable_signal",
        source="rule",
        saved=False,
    )


def test_extract_memories_from_turn_records_decisions(tmp_path):
    transient = extract_memories_from_turn(
        "这次先不要保存",
        auto_save=True,
        workspace_path=str(tmp_path),
    )
    assert transient and transient[0]["auto_save_eligible"] is False

    durable = extract_memories_from_turn(
        "以后都使用 pytest，这是我的习惯",
        auto_save=True,
        workspace_path=str(tmp_path),
    )
    assert durable and durable[0]["auto_save_eligible"] is True
    assert durable[0]["id"] is not None

    records = _read_log()
    by_eligible = {record["eligible"]: record for record in records}
    rejected = by_eligible[False]
    assert rejected["reason"] == "transient_instruction"
    assert rejected["saved"] is False
    assert rejected["source"] == "rule"
    accepted = by_eligible[True]
    assert accepted["reason"] == "explicit_durable_signal"
    assert accepted["saved"] is True


def test_extract_memories_from_turn_records_when_auto_save_disabled(tmp_path):
    candidates = extract_memories_from_turn(
        "我总是使用 black 格式化代码",
        auto_save=False,
        workspace_path=str(tmp_path),
    )
    assert candidates
    records = _read_log()
    assert records
    assert all(record["saved"] is False for record in records)


def test_memory_write_stats_aggregation():
    record_write_decision(
        content="A", mem_type="preference", eligible=True,
        reason="durable_identity", source="rule", saved=True,
    )
    record_write_decision(
        content="B", mem_type="preference", eligible=True,
        reason="explicit_durable_signal", source="model", saved=True,
    )
    record_write_decision(
        content="C", mem_type="constraint", eligible=False,
        reason="transient_instruction", source="rule", saved=False,
    )
    record_write_decision(
        content="D", mem_type="constraint", eligible=False,
        reason="missing_durable_signal", source="rule", saved=False,
    )

    stats = memory_write_stats()
    assert stats["decisions_total"] == 4
    assert stats["saved_total"] == 2
    assert stats["saved_rate"] == 0.5
    assert stats["rejected_total"] == 2
    assert stats["rejection_rate"] == 0.5
    assert stats["transient_rejected"] == 1
    assert stats["rejection_reasons_top"] == {
        "transient_instruction": 1,
        "missing_durable_signal": 1,
    }
    assert stats["by_source"] == {"rule": 3, "model": 1}
    assert stats["by_mem_type"] == {"preference": 2, "constraint": 2}
    assert stats["write_rejection_effectiveness"] == 0.5


def test_memory_write_stats_database_governance():
    os = MemoryOS()
    os.create("隔离的内容", lifecycle="quarantined")
    original = os.create("待修正的原始事实")
    os.correct(original["id"], "修正后的事实", expected_version=1, actor="user", reason="fix")

    stats = memory_write_stats()
    database = stats["database"]
    assert database["quarantined_count"] == 1
    assert database["correction_count"] == 1
    assert database["correction_rate"] == round(1 / 3, 4)
    assert database["candidate_count"] == 0
    assert database["rejected_candidate_count"] == 0


def test_memory_write_stats_without_log_file_still_reports_database(tmp_path):
    clear_write_metrics()
    os = MemoryOS()
    os.create("只有库里的记忆", lifecycle="candidate")

    stats = memory_write_stats()
    assert stats["decisions_total"] == 0
    assert stats["saved_total"] == 0
    assert stats["rejected_total"] == 0
    assert stats["saved_rate"] == 0.0
    assert stats["rejection_reasons_top"] == {}
    assert stats["write_rejection_effectiveness"] == 0.0
    assert stats["database"]["candidate_count"] == 1


def test_memory_write_stats_returns_error_dict_on_query_failure(monkeypatch):
    def boom():
        raise RuntimeError("db is down")

    monkeypatch.setattr("arforge.memory_writes._aggregate_database", boom)
    stats = memory_write_stats()
    assert "database" in stats
    assert "error" in stats["database"]
    assert "db is down" in stats["database"]["error"]
    assert "decisions_total" in stats


def test_clear_write_metrics_deletes_log_and_returns_line_count():
    for i in range(3):
        record_write_decision(
            content=f"clearable-{i}", mem_type="knowledge", eligible=False,
            reason="empty", source="rule", saved=False,
        )
    assert _log_path().is_file()

    assert clear_write_metrics() == 3
    assert not _log_path().exists()
    assert clear_write_metrics() == 0
