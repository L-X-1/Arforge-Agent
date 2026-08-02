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

    def to_dict(self) -> dict:
        return {
            "suite": self.suite,
            "total": self.total,
            "passed": self.passed,
            "success_rate": self.success_rate,
            "avg_score": self.avg_score,
            "total_tokens": self.total_tokens,
            "total_cost_cny": self.total_cost_cny,
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
                }
                for c in self.cases
            ],
        }
