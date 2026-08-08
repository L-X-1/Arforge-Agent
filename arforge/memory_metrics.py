"""记忆检索金标准评测：离线、确定性、绝不触碰真实库.

提供:
- ``MemoryGoldenCase`` / ``builtin_memory_golden_suite`` — "查询→应命中记忆"的金标准数据集
- ``run_memory_golden_eval`` — 强制隔离评测（sqlite in-memory，结束后恢复原库并 dispose）
- ``memory_metrics_history`` — 读取历史评测记录
- ``source_coverage_report`` — 真实库只读的事实来源覆盖率统计
- ``memory_metrics_report`` — 合成总报告（金标准最新结果 + 来源覆盖率 + 实际召回遥测）
"""

from __future__ import annotations

import json
import os
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from arforge.memory_os import MemoryOS, memory_scope_id

GOLDEN_PROJECT_ID = "golden-eval"
GOLDEN_WORKSPACE = "E:/golden-bench"
OTHER_WORKSPACE = "E:/other-bench"
GOLDEN_MIN_SCORE = 0.01
GOLDEN_TOP_K = 10

_PROVENANCE_TRACE_KEYS = frozenset(
    {
        "source_run_id",
        "source_event_checksum",
        "evidence_ids",
        "corrects_memory_uid",
        "signal_record_id",
    }
)
_TRACEABLE_SOURCES = frozenset({"runtime", "model", "auto", "user-corrected"})
_HISTORY_FILENAME = "memory_metrics.jsonl"


@dataclass
class MemoryGoldenCase:
    """一条金标准用例：查询 + 应当命中的记忆内容原文."""

    query: str
    relevant_content: list[str]
    workspace: str = GOLDEN_WORKSPACE
    description: str = ""
    top_k: int = GOLDEN_TOP_K


def _fixture(
    content: str,
    mem_type: str = "knowledge",
    importance: int = 1,
    workspace: str = GOLDEN_WORKSPACE,
    source: str = "user",
) -> dict[str, Any]:
    return {
        "content": content,
        "mem_type": mem_type,
        "importance": importance,
        "workspace": workspace,
        "source": source,
    }


# 相关记忆 fixture：内容与 suite 中的查询保持真实词面重叠，保证 BM25 可命中。
GOLDEN_FIXTURES: list[dict[str, Any]] = [
    _fixture("用户偏好使用简体中文回答所有问题", mem_type="preference", importance=4),
    _fixture("用户喜欢用 Tab 缩进代码而不是空格", mem_type="preference", importance=3),
    _fixture(
        "The user prefers British English spelling such as colour over color",
        mem_type="preference",
        importance=3,
    ),
    _fixture(
        "Project convention: every arforge function must carry a docstring",
        mem_type="convention",
        importance=4,
    ),
    _fixture(
        "Workflow: run ruff check and pytest before committing any change",
        mem_type="workflow",
        importance=4,
    ),
    _fixture(
        "Workflow: run tests with pytest on every change",
        mem_type="workflow",
        importance=3,
    ),
    _fixture(
        "Constraint: never log secrets or write them into source code",
        mem_type="constraint",
        importance=5,
    ),
    _fixture(
        "I am Arforge, an interactive CLI agent for software engineering",
        mem_type="identity",
        importance=5,
    ),
    _fixture(
        "Common failure: Windows paths with backslashes break inside JSON strings",
        mem_type="error",
        importance=4,
    ),
    _fixture(
        "Arforge runs on Python 3.11 and uses SQLAlchemy for persistence",
        mem_type="fact",
        importance=4,
    ),
    _fixture(
        "deploy to production is forbidden on Friday",
        mem_type="convention",
        importance=4,
    ),
    _fixture(
        "deploy to production is forbidden on Friday",
        mem_type="convention",
        importance=4,
        workspace=OTHER_WORKSPACE,
    ),
    _fixture(
        "pytest 是项目使用的测试框架",
        mem_type="convention",
        importance=4,
    ),
    _fixture(
        "Pytest 公司发布了新的产品线，与测试无关",
        mem_type="knowledge",
        importance=1,
    ),
    _fixture("apple 是一种常见的水果", mem_type="knowledge", importance=1),
    _fixture("Apple 公司是一家科技公司", mem_type="knowledge", importance=2),
    _fixture(
        "项目约定：所有 arforge 函数都必须带 docstring 文档字符串",
        mem_type="convention",
        importance=4,
    ),
    _fixture(
        "调试代码时禁止使用 print 语句，应该改用日志",
        mem_type="constraint",
        importance=4,
    ),
]

# decoy 干扰项：与所有查询仅弱相关，用于压低 precision 的对照组。
GOLDEN_DECOYS: list[dict[str, Any]] = [
    _fixture("用户喜欢在回答中保持简洁", mem_type="preference", importance=2),
    _fixture("The quick brown fox jumps over the lazy dog", mem_type="knowledge", importance=1),
    _fixture("会议安排在每天下午三点进行", mem_type="user", importance=2),
    _fixture("保持工作区整洁并及时归档旧文件", mem_type="convention", importance=2),
    _fixture("服务器部署环境需要监控磁盘用量", mem_type="knowledge", importance=2),
    _fixture("数据库连接失败时需要重试三次", mem_type="error", importance=2),
]


def builtin_memory_golden_suite() -> list[MemoryGoldenCase]:
    """返回内置金标准用例集（约 14 条，覆盖中英文偏好、约定、工作流、约束、身份、
    错误模式、版本事实、跨 scope 隔离、易混淆词与自然长句查询）。"""
    return [
        MemoryGoldenCase(
            query="回答问题时应该使用什么语言？",
            relevant_content=["用户偏好使用简体中文回答所有问题"],
            description="中文偏好召回",
        ),
        MemoryGoldenCase(
            query="代码缩进应该用 Tab 还是空格？",
            relevant_content=["用户喜欢用 Tab 缩进代码而不是空格"],
            description="编码风格偏好",
        ),
        MemoryGoldenCase(
            query="which spelling should I use, colour or color?",
            relevant_content=[
                "The user prefers British English spelling such as colour over color"
            ],
            description="英文拼写偏好",
        ),
        MemoryGoldenCase(
            query="does every arforge function need a docstring?",
            relevant_content=[
                "Project convention: every arforge function must carry a docstring"
            ],
            description="项目约定（英文）",
        ),
        MemoryGoldenCase(
            query="run pytest before committing a change",
            relevant_content=[
                "Workflow: run ruff check and pytest before committing any change",
                "Workflow: run tests with pytest on every change",
            ],
            description="提交前工作流，双相关项",
        ),
        MemoryGoldenCase(
            query="can secrets be logged in source code?",
            relevant_content=[
                "Constraint: never log secrets or write them into source code"
            ],
            description="安全约束",
        ),
        MemoryGoldenCase(
            query="what kind of agent am I?",
            relevant_content=[
                "I am Arforge, an interactive CLI agent for software engineering"
            ],
            description="身份",
        ),
        MemoryGoldenCase(
            query="why do Windows paths with backslashes break inside JSON?",
            relevant_content=[
                "Common failure: Windows paths with backslashes break inside JSON strings"
            ],
            description="错误模式",
        ),
        MemoryGoldenCase(
            query="which version of python does arforge run on?",
            relevant_content=[
                "Arforge runs on Python 3.11 and uses SQLAlchemy for persistence"
            ],
            description="版本事实",
        ),
        MemoryGoldenCase(
            query="deploy to production is forbidden on Friday",
            relevant_content=["deploy to production is forbidden on Friday"],
            description="跨 scope 隔离：同句只召回本 workspace",
        ),
        MemoryGoldenCase(
            query="用什么测试框架运行项目测试？",
            relevant_content=["pytest 是项目使用的测试框架"],
            description="易混淆词：pytest 测试框架 vs Pytest 公司",
        ),
        MemoryGoldenCase(
            query="apple 是什么水果？",
            relevant_content=["apple 是一种常见的水果"],
            description="易混淆词：水果 apple vs Apple 公司",
        ),
        MemoryGoldenCase(
            query="我注意到项目里的函数都写了 docstring，这是不是我们的项目约定，需要一直遵守吗？",
            relevant_content=[
                "项目约定：所有 arforge 函数都必须带 docstring 文档字符串"
            ],
            description="中文自然长句查询",
        ),
        MemoryGoldenCase(
            query="不要在调试代码的时候使用 print 语句，应该怎么做？",
            relevant_content=[
                "调试代码时禁止使用 print 语句，应该改用日志"
            ],
            description="调试约束",
        ),
    ]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _scope_project(workspace: str) -> str:
    """按 workspace 推导稳定的检索 scope 标识，fixture 写入与召回共用同一值."""
    return memory_scope_id(GOLDEN_PROJECT_ID, workspace)


def _fixture_key(workspace: str, content: str) -> str:
    """同一句话可能出现在不同 workspace，按 (workspace, content) 唯一标识."""
    return f"{workspace}\x00{content}"


def _evaluate_case(
    memory_os: MemoryOS,
    case: MemoryGoldenCase,
    content_to_id: dict[str, int],
    index: int,
) -> dict[str, Any]:
    """对单条金标准用例执行一次召回并计算指标."""
    response = memory_os.recall(
        case.query,
        project_id=_scope_project(case.workspace),
        workspace_path=case.workspace,
        top_k=case.top_k,
        min_score=GOLDEN_MIN_SCORE,
    )
    returned_ids = [int(item["id"]) for item in response.get("items", [])]
    relevant_ids = [
        content_to_id[_fixture_key(case.workspace, content)]
        for content in case.relevant_content
        if _fixture_key(case.workspace, content) in content_to_id
    ]
    relevant_set = set(relevant_ids)
    relevant_count = len(relevant_set)

    def recall_at(k: int) -> float:
        if not relevant_count:
            return 0.0
        top = set(returned_ids[:k])
        return sum(1 for memory_id in relevant_set if memory_id in top) / relevant_count

    def precision_at(k: int) -> float:
        top = returned_ids[:k]
        if not top:
            return 0.0
        return sum(1 for memory_id in top if memory_id in relevant_set) / len(top)

    hit_at_1 = bool(relevant_set & set(returned_ids[:1]))
    first_rank: int | None = None
    for rank, memory_id in enumerate(returned_ids, start=1):
        if memory_id in relevant_set:
            first_rank = rank
            break
    mrr = 1.0 / first_rank if first_rank is not None else 0.0
    missing_relevant = [
        content
        for content in case.relevant_content
        if content_to_id.get(_fixture_key(case.workspace, content)) not in returned_ids
    ]
    return {
        "id": index,
        "query": case.query,
        "workspace": case.workspace,
        "description": case.description,
        "top_k": case.top_k,
        "relevant_count": relevant_count,
        "returned_ids": returned_ids,
        "recall_at_1": round(recall_at(1), 4),
        "recall_at_5": round(recall_at(5), 4),
        "recall_at_10": round(recall_at(10), 4),
        "precision_at_1": round(precision_at(1), 4),
        "precision_at_5": round(precision_at(5), 4),
        "precision_at_10": round(precision_at(10), 4),
        "hit_at_1": bool(hit_at_1),
        "first_relevant_rank": first_rank,
        "mrr": round(mrr, 4),
        "missing_relevant": missing_relevant,
    }


def _aggregate(cases: list[dict[str, Any]]) -> dict[str, float]:
    """聚合所有用例的均值指标."""
    count = max(len(cases), 1)
    return {
        "mean_recall_at_1": round(sum(c["recall_at_1"] for c in cases) / count, 4),
        "mean_recall_at_5": round(sum(c["recall_at_5"] for c in cases) / count, 4),
        "mean_recall_at_10": round(sum(c["recall_at_10"] for c in cases) / count, 4),
        "mean_precision_at_1": round(sum(c["precision_at_1"] for c in cases) / count, 4),
        "mean_precision_at_5": round(sum(c["precision_at_5"] for c in cases) / count, 4),
        "mean_precision_at_10": round(sum(c["precision_at_10"] for c in cases) / count, 4),
        "hit_rate_at_1": round(sum(c["hit_at_1"] for c in cases) / count, 4),
        "mean_mrr": round(sum(c["mrr"] for c in cases) / count, 4),
    }


def _history_path() -> str:
    base = os.environ.get("ARFORGE_HOME", os.path.expanduser("~/.arforge"))
    return os.path.join(base, _HISTORY_FILENAME)


def _append_history(result: dict[str, Any]) -> None:
    """把本次评测的聚合结果追加到历史文件；写失败静默."""
    try:
        path = _history_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        record = {
            "timestamp": _now_iso(),
            "schema_version": result.get("schema_version"),
            "algorithm": result.get("algorithm"),
            "is_isolated": result.get("is_isolated"),
            "fixture_count": result.get("fixture_count"),
            "case_count": result.get("case_count"),
        }
        for key in (
            "mean_recall_at_1",
            "mean_recall_at_5",
            "mean_recall_at_10",
            "mean_precision_at_1",
            "mean_precision_at_5",
            "mean_precision_at_10",
            "hit_rate_at_1",
            "mean_mrr",
        ):
            record[key] = result.get(key)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def run_memory_golden_eval(
    suite: list[MemoryGoldenCase] | None = None,
) -> dict[str, Any]:
    """在强制隔离的内存库中运行金标准评测，绝不触碰真实库.

    内部流程：保存当前 ``ARFORGE_DB_URL`` → 切换为 ``sqlite:///:memory:`` 并
    ``dispose_engines()`` → 写入 fixture → 逐条 recall → 计算指标 → finally
    恢复原 env（原本为 None 则删除该变量）并再次 ``dispose_engines()``。
    """
    from arforge.database.engine import dispose_engines

    suite = suite if suite is not None else builtin_memory_golden_suite()
    previous_url = os.environ.get("ARFORGE_DB_URL")
    os.environ["ARFORGE_DB_URL"] = "sqlite:///:memory:"
    dispose_engines()
    try:
        memory_os = MemoryOS()
        fixtures = [*GOLDEN_FIXTURES, *GOLDEN_DECOYS]
        content_to_id: dict[str, int] = {}
        for fixture in fixtures:
            record = memory_os.create(
                fixture["content"],
                mem_type=fixture["mem_type"],
                importance=fixture["importance"],
                source=fixture["source"],
                project_id=_scope_project(fixture["workspace"]),
                workspace_path=fixture["workspace"],
            )
            content_to_id[_fixture_key(fixture["workspace"], fixture["content"])] = int(record["id"])

        cases = [
            _evaluate_case(memory_os, case, content_to_id, index)
            for index, case in enumerate(suite, start=1)
        ]
        result: dict[str, Any] = {
            "schema_version": 1,
            "algorithm": "golden_memory_retrieval",
            "generated_at": _now_iso(),
            "is_isolated": True,
            "fixture_count": len(fixtures),
            "case_count": len(suite),
            "cases": cases,
            **_aggregate(cases),
        }
        _append_history(result)
        return result
    finally:
        if previous_url is None:
            os.environ.pop("ARFORGE_DB_URL", None)
        else:
            os.environ["ARFORGE_DB_URL"] = previous_url
        dispose_engines()


def memory_metrics_history(limit: int = 50) -> list[dict[str, Any]]:
    """读取最近的金标准评测历史记录，文件不存在时返回空列表."""
    bounded = max(1, min(int(limit), 500))
    try:
        path = _history_path()
        if not os.path.isfile(path):
            return []
        records: list[dict[str, Any]] = []
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    records.append(json.loads(stripped))
                except ValueError:
                    continue
        return records[-bounded:]
    except Exception:
        return []


def source_coverage_report() -> dict[str, Any]:
    """统计真实库中 active 记忆的事实来源覆盖率（只读，不做隔离）.

    "可溯源"定义：provenance 为 dict 且含溯源键之一，或 source 属于
    runtime/model/auto/user-corrected。
    """
    try:
        from arforge.database import Memory, get_session

        with get_session() as session:
            rows = session.query(Memory).filter(Memory.lifecycle == "active").all()
        active = [
            {
                "source": str(row.source or ""),
                "provenance": dict(row.provenance or {}),
                "content": str(row.content or ""),
            }
            for row in rows
        ]
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}

    by_source: Counter[str] = Counter()
    by_kind: Counter[str] = Counter()
    traceable = 0
    untraceable_samples: list[dict[str, str]] = []
    for item in active:
        source = item["source"]
        provenance = item["provenance"] if isinstance(item["provenance"], dict) else {}
        by_source[source] += 1
        by_kind[str(provenance.get("kind") or "none")] += 1
        is_traceable = bool(set(provenance) & _PROVENANCE_TRACE_KEYS) or source in _TRACEABLE_SOURCES
        if is_traceable:
            traceable += 1
        elif len(untraceable_samples) < 5:
            untraceable_samples.append({"source": source, "content": item["content"][:80]})

    total = len(active)
    return {
        "schema_version": 1,
        "active_total": total,
        "traceable": traceable,
        "source_coverage_rate": round(traceable / total, 4) if total else 0.0,
        "by_source": [
            {"source": key, "count": value}
            for key, value in sorted(by_source.items())
        ],
        "by_provenance_kind": [
            {"kind": key, "count": value}
            for key, value in sorted(by_kind.items())
        ],
        "untraceable_samples": untraceable_samples,
    }


def memory_metrics_report() -> dict[str, Any]:
    """合成总报告：金标准最新结果 + 来源覆盖率 + 实际召回遥测."""
    history = memory_metrics_history(limit=1)
    report: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": _now_iso(),
        "golden_eval": history[-1] if history else None,
        "source_coverage": source_coverage_report(),
    }
    try:
        report["recall_quality"] = MemoryOS().recall_quality()
    except Exception as exc:
        report["recall_quality"] = {"error": f"{type(exc).__name__}: {exc}"}
    return report
