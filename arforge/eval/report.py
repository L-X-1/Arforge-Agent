# Eval API compatibility layer — appends to arforge/eval/runner.py

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class EvalCase:
    """Single eval task outcome (CLI-compatible)."""
    task_id: str = ""
    category: str = ""
    success: bool = False
    steps: int = 0
    tokens: int = 0
    error: str | None = None
    judge_reason: str | None = None
    answer: str = ""
    score: float = 0.0
    artifact_path: str | None = None
    token_budget: int = 0
    cost_cny: float = 0.0
    elapsed_sec: float = 0.0


@dataclass
class EvalReport:
    """Batch eval report (CLI-compatible)."""
    suite: str = "core"
    cases: list[EvalCase] = field(default_factory=list)
    total: int = 0
    passed: int = 0
    success_rate: float = 0.0
    avg_score: float = 0.0  # for CLI compatibility
    total_tokens: int = 0
    total_cost_cny: float = 0.0
    total_elapsed_sec: float = 0.0

    def by_category_summary(self) -> dict[str, dict]:
        """按 category 聚合的经济性摘要。

        返回 {category: {"total", "passed", "success_rate", "tokens",
        "cost_cny", "elapsed_sec"}}，success_rate 保留 3 位；空 category 归入
        "unknown"。
        """
        agg: dict[str, dict] = {}
        for c in self.cases:
            cat = c.category or "unknown"
            if cat not in agg:
                agg[cat] = {
                    "total": 0,
                    "passed": 0,
                    "tokens": 0,
                    "cost_cny": 0.0,
                    "elapsed_sec": 0.0,
                }
            item = agg[cat]
            item["total"] += 1
            if c.success:
                item["passed"] += 1
            item["tokens"] += c.tokens
            item["cost_cny"] += c.cost_cny
            item["elapsed_sec"] += c.elapsed_sec
        result: dict[str, dict] = {}
        for cat, item in agg.items():
            total = item["total"]
            result[cat] = {
                "total": total,
                "passed": item["passed"],
                "success_rate": round(item["passed"] / total, 3) if total else 0.0,
                "tokens": item["tokens"],
                "cost_cny": round(item["cost_cny"], 6),
                "elapsed_sec": round(item["elapsed_sec"], 6),
            }
        return result

    def to_dict(self) -> dict:
        """序列化为 CLI 兼容 dict，附经济性派生指标（分母为 0 时返回 None）。"""
        return {
            "suite": self.suite,
            "total": self.total,
            "passed": self.passed,
            "success_rate": self.success_rate,
            "avg_score": self.avg_score,
            "total_tokens": self.total_tokens,
            "total_cost_cny": self.total_cost_cny,
            "total_elapsed_sec": self.total_elapsed_sec,
            "success_per_cost_cny": (
                round(self.passed / self.total_cost_cny, 6) if self.total_cost_cny else None
            ),
            "success_per_elapsed_sec": (
                round(self.passed / self.total_elapsed_sec, 6)
                if self.total_elapsed_sec
                else None
            ),
            "cost_cny_per_success": (
                round(self.total_cost_cny / self.passed, 6) if self.passed else None
            ),
            "tokens_per_success": (
                round(self.total_tokens / self.passed) if self.passed else None
            ),
            "by_category": self.by_category_summary(),
            "cases": [
                {
                    "task_id": c.task_id,
                    "category": c.category,
                    "success": c.success,
                    "steps": c.steps,
                    "tokens": c.tokens,
                    "error": c.error,
                    "judge_reason": c.judge_reason,
                    "answer": c.answer,
                    "score": c.score,
                    "artifact_path": c.artifact_path,
                    "token_budget": c.token_budget,
                    "cost_cny": c.cost_cny,
                    "elapsed_sec": c.elapsed_sec,
                }
                for c in self.cases
            ],
        }
