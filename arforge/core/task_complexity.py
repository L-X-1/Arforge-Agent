"""P0 1.3: Task complexity classifier — dynamic max_steps and incomplete reports.

Estimated from user prompt heuristics, not LLM calls, so it is fast,
deterministic, and never consumes tokens.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class ComplexityTier(Enum):
    SIMPLE = "simple"    # 10 steps
    MEDIUM = "medium"    # 25 steps
    COMPLEX = "complex"  # 80 steps
    UNKNOWN = "unknown"  # fallback 15 steps


# ---------- signal words ----------
_REFACTOR = ("refactor", "restructure", "reorganize", "migrate", "extract")
_MULTI_FILE = ("across files", "multiple files", "several files", "every", "all files")
_COMPLEX_TASK = ("implement", "build", "create a", "add feature", "write a", "redesign")
_PROJECT_TASK = ("project", "system", "application", "spring boot", "springboot", "vue", "react", "full-stack", "full stack", "database schema", "rest api", "restful")
_MEDIUM_TASK = ("add test", "fix bug", "fix the", "repair", "update to", "upgrade")
_SIMPLE_TASK = ("explain", "what is", "how to", "hello", "list", "show", "find")
_ZH_REFACTOR = ("重构", "迁移", "提取", "拆分", "重组")
_ZH_MULTI_FILE = ("多文件", "所有文件", "整个项目", "整个仓库", "全项目")
_ZH_COMPLEX = ("实现", "构建", "创建", "新增功能", "重新设计")
_ZH_PROJECT = ("项目", "系统", "应用", "数据库", "接口", "前后端")
_ZH_MEDIUM = ("添加测试", "修复", "调试", "更新", "升级", "优化")
_ZH_SIMPLE = ("解释", "什么是", "如何", "你好", "列出", "显示", "查找")


def estimate_complexity(task: str) -> ComplexityTier:
    """Estimate task complexity from the user prompt text.

    Heuristic only — no model calls, always fast and deterministic.
    """
    low = (task or "").lower()

    # Complex signals
    refactor_hits = sum(1 for w in _REFACTOR if w in low)
    multi_hits = sum(1 for w in _MULTI_FILE if w in low)
    complex_hits = sum(1 for w in _COMPLEX_TASK if w in low)
    refactor_hits += sum(1 for w in _ZH_REFACTOR if w in low)
    multi_hits += sum(1 for w in _ZH_MULTI_FILE if w in low)
    complex_hits += sum(1 for w in _ZH_COMPLEX if w in low)
    if refactor_hits >= 1 or refactor_hits + multi_hits >= 2:
        return ComplexityTier.COMPLEX
    if complex_hits >= 1 or multi_hits >= 1:
        return ComplexityTier.MEDIUM

    # Project-building tasks (system/application/project) → COMPLEX
    project_hits = sum(1 for w in _PROJECT_TASK if w in low)
    project_hits += sum(1 for w in _ZH_PROJECT if w in low)
    if project_hits >= 2:
        return ComplexityTier.COMPLEX

    # Medium signals
    medium_hits = sum(1 for w in _MEDIUM_TASK if w in low)
    medium_hits += sum(1 for w in _ZH_MEDIUM if w in low)
    if medium_hits >= 1:
        return ComplexityTier.MEDIUM

    # Simple signals
    simple_hits = sum(1 for w in _SIMPLE_TASK if w in low)
    simple_hits += sum(1 for w in _ZH_SIMPLE if w in low)
    if simple_hits >= 1:
        return ComplexityTier.SIMPLE

    return ComplexityTier.UNKNOWN


# Tier → steps mapping
COMPLEXITY_STEPS: dict[ComplexityTier, int] = {
    ComplexityTier.SIMPLE: 10,
    ComplexityTier.MEDIUM: 25,
    ComplexityTier.COMPLEX: 80,
    ComplexityTier.UNKNOWN: 15,
}


@dataclass
class IncompleteReport:
    """Structured report when an agentic run hits max_steps."""
    task: str
    tier: ComplexityTier
    max_steps: int
    steps_used: int
    tools_called: int
    failures: int
    last_answer_preview: str  # first 200 chars of final_answer
    suggested_next: str


def build_incomplete_report(
    *,
    task: str,
    tier: ComplexityTier,
    max_steps: int,
    steps_used: int,
    tool_calls_log: list[dict],
    answer: str,
) -> IncompleteReport:
    """Construct the incomplete report when max_steps is reached."""
    failures = sum(1 for tc in tool_calls_log if not tc.get("success", True))
    preview = (answer or "")[:200].strip()

    if tier in (ComplexityTier.SIMPLE, ComplexityTier.UNKNOWN):
        suggested = "Resume with 'arforge code --resume <run_id>' or increase --max-steps."
    elif tier is ComplexityTier.MEDIUM:
        suggested = "Resume with 'arforge code --resume <run_id>' and a higher --max-steps, or split the task."
    else:
        suggested = "Complex tasks often need 40+ steps. Resume with 'arforge code --resume <run_id>'."

    return IncompleteReport(
        task=task,
        tier=tier,
        max_steps=max_steps,
        steps_used=steps_used,
        tools_called=len(tool_calls_log),
        failures=failures,
        last_answer_preview=preview,
        suggested_next=suggested,
    )


def render_incomplete_report(report: IncompleteReport) -> str:
    return (
        f"\n--- Incomplete Report ---\n"
        f"  Task        : {report.task}\n"
        f"  Tier        : {report.tier.value} (max {report.max_steps} steps)\n"
        f"  Steps used  : {report.steps_used}/{report.max_steps}\n"
        f"  Tools called: {report.tools_called} ({report.failures} failed)\n"
        f"  Preview     : {report.last_answer_preview or '(no answer yet)'}\n"
        f"  Next        : {report.suggested_next}\n"
        f"--------------------------\n"
    )


__all__ = [
    "ComplexityTier",
    "COMPLEXITY_STEPS",
    "IncompleteReport",
    "build_incomplete_report",
    "render_incomplete_report",
    "estimate_complexity",
]
