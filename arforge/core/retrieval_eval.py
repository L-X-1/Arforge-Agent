"""v1-2.3：检索质量评估——给定查询，断言召回的文件是否正确，量化命中率。

检索是本地确定性的（project_scanner 关键词扫描），不调模型、不花钱。用 Arforge
自身源码作语料 + 一组"查询→应命中文件"金标准，跑出召回命中率基线，为"回答能引用
正确来源"提供检索准确性的量化依据。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class RetrievalTask:
    query: str
    expect_any: list[str]  # 召回结果含这些文件名之一即算命中
    description: str = ""


@dataclass
class RetrievalCase:
    query: str
    hit: bool
    recalled: list[str] = field(default_factory=list)


@dataclass
class RetrievalReport:
    cases: list = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.cases)

    @property
    def hits(self) -> int:
        return sum(1 for c in self.cases if c.hit)

    @property
    def hit_rate(self) -> float:
        return round(self.hits / self.total, 4) if self.total else 0.0

    def to_dict(self) -> dict:
        return {
            "total": self.total,
            "hits": self.hits,
            "hit_rate": self.hit_rate,
            "cases": [{"query": c.query, "hit": c.hit, "recalled": c.recalled} for c in self.cases],
        }


def search_files(query: str, root, limit: int = 20) -> list[str]:
    """在 root 下按关键词检索 .py，返回命中文件的相对路径（确定性、本地、不调模型）。"""
    from arforge.project_scanner import scan_project

    root = Path(root)
    out: list[str] = []
    for item in scan_project(root, suffixes=(".py",)):
        rel = item["path"]
        try:
            text = (root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if query.lower() in text.lower():
            out.append(rel)
            if len(out) >= limit:
                break
    return out


def run_retrieval_eval(tasks, root, search_fn=search_files) -> RetrievalReport:
    """对每个查询跑检索，断言召回含期望文件之一，聚合命中率。"""
    report = RetrievalReport()
    for t in tasks:
        recalled = search_fn(t.query, root)
        hit = any(any(exp in r for r in recalled) for exp in t.expect_any)
        report.cases.append(RetrievalCase(query=t.query, hit=hit, recalled=recalled[:10]))
    return report


def builtin_retrieval_tasks() -> list:
    """针对 Arforge 自身源码的金标准检索任务（查询 → 应命中文件）。"""
    return [
        RetrievalTask("DENY_ARG_PATTERNS", ["basic_tools.py"], "高危命令守卫"),
        RetrievalTask("class TaskLedger", ["task_ledger.py"], "任务清单"),
        RetrievalTask("def run_tool_loop", ["agentic.py"], "agentic 循环"),
        RetrievalTask("def verify_path", ["edit_verify.py"], "改后校验"),
        RetrievalTask("class RunTransaction", ["run_transaction.py"], "任务回滚"),
        RetrievalTask("def interrupt_hook", ["interrupt.py"], "运行中可打断"),
        RetrievalTask("def estimate_max_steps", ["complexity.py"], "动态步数"),
        RetrievalTask("def check_regression", ["eval_baseline.py"], "eval 回归门禁"),
        RetrievalTask("def run_impacted_tests", ["regression_tools.py"], "回归保护"),
        RetrievalTask("class HookManager", ["hooks.py"], "钩子总线"),
    ]


def arforge_source_root() -> Path:
    """Arforge 包目录（默认检索语料）。"""
    import arforge

    return Path(arforge.__file__).resolve().parent
