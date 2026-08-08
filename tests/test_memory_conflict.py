"""记忆矛盾检测器与金标准评测的单元测试。"""

from __future__ import annotations

import sys

from arforge.memory_conflict import (
    builtin_conflict_suite,
    canonical_path,
    conflict_benchmark_history,
    derive_claim,
    detect_claim_conflicts,
    normalize,
    normalize_claim_key,
    run_conflict_benchmark,
    sanitize,
)


def _memory(memory_id, content, *, tags="", project_id="", workspace_path="", scope="global"):
    return {
        "id": memory_id,
        "content": content,
        "tags": tags,
        "project_id": project_id,
        "workspace_path": workspace_path,
        "scope": scope,
    }


def test_derive_claim_chinese_pattern():
    claim = derive_claim("服务器端口是 8080")
    assert claim == {
        "key": "服务器端口",
        "value": "8080",
        "basis": "deterministic-pattern-v1",
    }


def test_derive_claim_english_pattern():
    claim = derive_claim("The deployment region is us-east-1")
    assert claim == {
        "key": "deployment-region",
        "value": "us-east-1",
        "basis": "deterministic-pattern-v1",
    }
    assert derive_claim("deployment region is eu-west-1")["key"] == "deployment-region"


def test_derive_claim_explicit_fact_key_tag():
    claim = derive_claim("默认模型是 gpt-4", tags="fact,version,fact-key:model")
    assert claim == {
        "key": "model",
        "value": "默认模型是 gpt-4",
        "basis": "explicit-tag",
    }


def test_derive_claim_fact_key_tag_case_insensitive_prefix():
    claim = derive_claim("默认模型是 gpt-4", tags="FACT-KEY: model")
    assert claim is not None
    assert claim["key"] == "model"
    assert claim["basis"] == "explicit-tag"


def test_derive_claim_no_match():
    assert derive_claim("今天天气不错") is None
    assert derive_claim("请记得提交代码") is None
    assert derive_claim("") is None


def test_derive_claim_keyword_at_start_does_not_match():
    # 与桌面端 TS 正则语义一致：关键字在开头时捕获组无法匹配（需至少 1 个前缀字符）。
    assert derive_claim("端口是 8080") is None
    assert derive_claim("版本是 1.2.0") is None
    assert derive_claim("model is gpt-4") is None


def test_derive_claim_sanitizes_control_characters():
    claim = derive_claim("服务器端口\u0007是 8080")
    assert claim is not None
    assert claim["value"] == "8080"


def test_normalize_claim_key_whitespace_underscore_case():
    assert normalize_claim_key("  The  Port  ") == "the-port"
    assert normalize_claim_key("my_port") == "my-port"
    assert normalize_claim_key("服务器端口") == "服务器端口"


def test_normalize_claim_key_junk_and_truncation():
    assert normalize_claim_key("region/us-east@1") == "region-us-east-1"
    long_key = "k" * 200
    assert len(normalize_claim_key(long_key)) == 160


def test_normalize_value_whitespace_and_case():
    assert normalize("  Hello   World  ") == "hello world"


def test_sanitize_removes_control_chars_and_trims():
    assert sanitize("\u0000abc\u007f  def\u000b") == "abc  def"


def test_canonical_path_windows_rules():
    if sys.platform == "win32":
        assert canonical_path("C:\\Work\\Repo\\") == "c:/work/repo"
        assert canonical_path("///") == "/"
        assert canonical_path("") == "/"
    else:
        assert canonical_path("/Work/Repo/") == "/work/repo"


def test_detect_claim_conflicts_true_conflict():
    memories = [
        _memory(1, "服务器端口是 8080", project_id="p1", workspace_path="/work", scope="workspace"),
        _memory(2, "服务器端口是 9090", project_id="p1", workspace_path="/work", scope="workspace"),
    ]
    outcome = detect_claim_conflicts(memories)
    assert outcome["truncated"] is False
    assert len(outcome["items"]) == 1
    item = outcome["items"][0]
    assert item["left_id"] == 1
    assert item["right_id"] == 2
    assert item["key"] == "服务器端口"
    assert item["left_value"] == "8080"
    assert item["right_value"] == "9090"
    assert item["basis"] == "deterministic-pattern-v1"


def test_detect_claim_conflicts_same_value_not_conflict():
    memories = [
        _memory(1, "服务器端口是 8080", scope="global"),
        _memory(2, "服务器端口是  8080", scope="global"),
    ]
    assert detect_claim_conflicts(memories)["items"] == []


def test_detect_claim_conflicts_cross_scope_not_conflict():
    memories = [
        _memory(1, "服务器端口是 8080", project_id="p1", workspace_path="/work", scope="workspace"),
        _memory(2, "服务器端口是 9090", scope="global"),
    ]
    assert detect_claim_conflicts(memories)["items"] == []


def test_detect_claim_conflicts_scope_derived_from_fields():
    memories = [
        _memory(1, "服务器端口是 8080", project_id="p1", workspace_path="/work"),
        _memory(2, "服务器端口是 9090", project_id="p1", workspace_path="/work"),
    ]
    assert len(detect_claim_conflicts(memories)["items"]) == 1


def test_detect_claim_conflicts_different_key_not_conflict():
    memories = [
        _memory(1, "服务器端口是 8080", scope="global"),
        _memory(2, "项目时区是 UTC", scope="global"),
    ]
    assert detect_claim_conflicts(memories)["items"] == []


def test_detect_claim_conflicts_explicit_tag_basis_wins():
    memories = [
        _memory(1, "默认模型是 gpt-4", tags="fact-key:默认模型", scope="global"),
        _memory(2, "默认模型是 gpt-4o", scope="global"),
    ]
    items = detect_claim_conflicts(memories)["items"]
    assert len(items) == 1
    assert items[0]["key"] == "默认模型"
    assert items[0]["basis"] == "explicit-tag"


def test_detect_claim_conflicts_truncated_at_200():
    memories = [_memory(index, f"服务器端口是 {index}", scope="global") for index in range(1, 22)]
    outcome = detect_claim_conflicts(memories)
    assert outcome["truncated"] is True
    assert len(outcome["items"]) == 200
    assert all(item["left_id"] < item["right_id"] for item in outcome["items"])


def test_detect_claim_conflicts_within_limit_not_truncated():
    memories = [_memory(index, f"服务器端口是 {index}", scope="global") for index in range(1, 11)]
    outcome = detect_claim_conflicts(memories)
    assert outcome["truncated"] is False
    assert len(outcome["items"]) == 45  # C(10, 2)


def test_builtin_conflict_suite_shape():
    suite = builtin_conflict_suite()
    assert len(suite) >= 10
    for case in suite:
        assert {"memories", "expect_conflict", "description"} <= set(case)
        assert len(case["memories"]) >= 2


def test_run_conflict_benchmark_all_green(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    metrics = run_conflict_benchmark()
    assert metrics["detection_rate"] == 1.0
    assert metrics["false_positive_rate"] == 0.0
    assert metrics["precision"] == 1.0
    assert metrics["recall"] == 1.0
    assert metrics["truncated"] is False
    assert len(metrics["case_results"]) == len(builtin_conflict_suite())
    assert all(result["verdict"] in {"tp", "tn"} for result in metrics["case_results"])


def test_run_conflict_benchmark_appends_history(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    run_conflict_benchmark()
    second = run_conflict_benchmark(builtin_conflict_suite())
    history = conflict_benchmark_history()
    assert len(history) == 2
    assert history[-1]["detection_rate"] == second["detection_rate"]
    assert "timestamp" in history[-1]


def test_conflict_benchmark_history_missing_file(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    assert conflict_benchmark_history() == []


def test_conflict_benchmark_history_custom_suite(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))
    custom = [
        {
            "memories": [
                _memory(1, "开发语言是 Python", scope="global"),
                _memory(2, "开发语言是 JavaScript", scope="global"),
            ],
            "expect_conflict": True,
            "description": "自定义 case",
        },
        {
            "memories": [
                _memory(1, "今天天气不错", scope="global"),
                _memory(2, "晚饭记得买菜", scope="global"),
            ],
            "expect_conflict": False,
            "description": "自定义无关内容",
        },
    ]
    metrics = run_conflict_benchmark(custom)
    assert metrics["detection_rate"] == 1.0
    assert metrics["false_positive_rate"] == 0.0
    assert [result["verdict"] for result in metrics["case_results"]] == ["tp", "tn"]
