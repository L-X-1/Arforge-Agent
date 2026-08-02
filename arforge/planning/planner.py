"""Task planning — model-driven when available, intelligent templates offline.

When a model adapter is provided, the planner calls the LLM to decompose the
goal into 3-7 concrete steps.  When offline, it uses task-type-aware templates
instead of a single hardcoded 5-step recipe.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from arforge.models.model_adapter import ModelAdapter


# ====================================================================
# Data model
# ====================================================================


@dataclass
class PlanStep:
    id: int
    title: str
    status: str = "pending"
    detail: str = ""
    risk: str = ""


@dataclass
class ExecutionPlan:
    goal: str
    steps: list[PlanStep] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)

    def to_markdown(self) -> str:
        lines = [f"# Plan: {self.goal}", ""]
        for step in self.steps:
            risk_tag = f" ⚠️{step.risk}" if step.risk else ""
            lines.append(f"{step.id}. [{step.status}] {step.title}{risk_tag}")
            if step.detail:
                lines.append(f"   {step.detail}")
        if self.risks:
            lines.append("")
            lines.append("## Risks")
            lines.extend(f"- {risk}" for risk in self.risks)
        return "\n".join(lines)


# ====================================================================
# Task type detection
# ====================================================================


def _detect_task_type(goal: str) -> str:
    """Classify a goal into question / coding / analysis / general.

    Uses substring matching for Chinese keywords and word-boundary regex
    for English keywords (since \\b does not match around CJK characters).
    """
    text = goal.lower().strip()

    # -- Chinese keyword sets (substring match — no \\b needed) --
    cn_question = {"什么是", "是什么", "什么叫", "啥是", "何为", "为什么", "怎么", "如何", "怎样", "解释", "说明", "介绍一下", "介绍"}
    cn_coding = {"修复", "实现", "修改", "编写", "添加", "增加", "删除", "重构", "代码", "函数", "模块", "接口", "部署", "构建", "发布"}
    cn_analysis = {"分析", "评估", "审查", "审计", "检查", "诊断", "性能", "安全", "优化"}

    if any(kw in text for kw in cn_question):
        return "question"

    # Analysis checked before coding — "审查代码/审计安全" are analysis, not coding
    if any(kw in text for kw in cn_analysis):
        return "analysis"

    if any(kw in text for kw in cn_coding):
        return "coding"

    # -- English keyword patterns (word-boundary regex) --
    en_question = re.search(r"\b(how|what|why|when|where|describe|explain)\b", text)
    if en_question:
        return "question"

    # English analysis before coding for same reason
    en_analysis = re.search(r"\b(review|analyze|audit|diagnose|performance|security|optimize)\b", text)
    if en_analysis:
        return "analysis"

    en_coding = re.search(r"\b(fix|bug|implement|refactor|code|function|class|module|api|deploy|build|release)\b", text)
    if en_coding:
        return "coding"

    # -- Question mark --
    if "?" in text or "？" in text:
        return "question"

    return "general"


# ====================================================================
# Offline templates (used when model is None)
# ====================================================================


_QUESTION_TEMPLATE = [
    "理解问题的核心：{goal}",
    "检索相关知识库和记忆",
    "组织清晰的解释性回答",
    "提供示例或引用来源",
]

_CODING_TEMPLATE = [
    "理解代码变更需求：{goal}",
    "定位需要修改的文件和函数",
    "实现最小的、可验证的改动",
    "运行编译、lint 和测试验证",
    "记录变更证据和剩余风险",
]

_ANALYSIS_TEMPLATE = [
    "明确分析范围和目标：{goal}",
    "收集相关代码、日志和指标",
    "执行多维度检查（正确性/性能/安全）",
    "整理发现并按严重度排序",
    "给出可执行的改进建议",
]

_GENERAL_TEMPLATE = [
    "理解任务目标：{goal}",
    "拆解为可执行的子任务",
    "逐步执行并验证每一步",
    "总结结果和后续步骤",
]


def _build_template_steps(task_type: str, goal: str) -> list[str]:
    """Return template steps with goal interpolated into the first step."""
    templates = {
        "question": _QUESTION_TEMPLATE,
        "coding": _CODING_TEMPLATE,
        "analysis": _ANALYSIS_TEMPLATE,
        "general": _GENERAL_TEMPLATE,
    }
    steps = templates.get(task_type, _GENERAL_TEMPLATE)
    return [s.format(goal=goal) for s in steps]


# ====================================================================
# Model-driven planning
# ====================================================================


def _plan_via_model(goal: str, adapter: "ModelAdapter") -> list[dict] | None:
    """Call the LLM to decompose a goal into structured steps.

    Returns a list of {title, detail, risk} dicts, or None on failure.
    """
    prompt = (
        "你是一个资深技术规划专家。将以下任务分解为 3-7 个可执行的步骤。\n"
        "每步必须包含：\n"
        "  - title: 简短动词短语（中文，10 字以内）\n"
        "  - detail: 具体要做的事情（一句话）\n"
        "  - risk: 可能的风险（无风险填 '低'）\n\n"
        "输出纯 JSON 数组，不要包含其他内容：\n"
        '[{"title": "...", "detail": "...", "risk": "..."}, ...]\n\n'
        f"任务：{goal}"
    )

    try:
        raw = adapter.generate(
            [{"role": "user", "content": prompt}],
            max_tokens=1024,
            temperature=0.3,
        )
        return _parse_plan_json(raw)
    except Exception:
        return None


def _parse_plan_json(raw: str) -> list[dict] | None:
    """Extract a JSON array of step objects from model output."""
    # Find JSON array boundaries
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return None

    json_str = raw[start : end + 1]
    try:
        parsed = json.loads(json_str)
        if isinstance(parsed, list) and len(parsed) > 0:
            # Validate structure
            for item in parsed:
                if not isinstance(item, dict) or "title" not in item:
                    return None
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass
    return None


# ====================================================================
# Public API
# ====================================================================


def generate_task_plan(goal: str, model: "ModelAdapter | None" = None) -> list[str]:
    """Generate a list of action-step strings for the given goal.

    When *model* is provided, the LLM decomposes the goal into 3-7 concrete
    steps.  When *model* is None, task-type-aware templates are used (question /
    coding / analysis / general) instead of a single hardcoded recipe.
    """
    goal = goal.strip()
    if not goal:
        return []

    # Model-driven path
    if model is not None:
        steps = _plan_via_model(goal, model)
        if steps:
            return [s["title"] for s in steps]
        # Fall through to template on failure

    # Offline template path
    task_type = _detect_task_type(goal)
    return _build_template_steps(task_type, goal)


def quick_plan(task: str, model: "ModelAdapter | None" = None) -> ExecutionPlan:
    """Build an ExecutionPlan with step titles.

    When *model* is provided, forwards to the LLM for task-specific planning.
    When offline, uses task-type-aware templates.
    """
    titles = generate_task_plan(task, model=model)
    steps = []
    for i, title in enumerate(titles):
        detail = ""
        risk = ""
        # If we have structured data from model, populate detail/risk
        steps.append(PlanStep(id=i + 1, title=title, detail=detail, risk=risk))

    return ExecutionPlan(goal=task, steps=steps)


def quick_plan_with_model(task: str) -> ExecutionPlan:
    """Convenience: generate a plan using the default model adapter.

    Falls back to offline templates if the model is unavailable.
    """
    try:
        from arforge.product.model_config_runtime import get_model_config

        adapter = get_model_config().create_active_adapter()
        return quick_plan(task, model=adapter)
    except Exception:
        return quick_plan(task, model=None)


def format_plan_display(plan: ExecutionPlan) -> str:
    return plan.to_markdown()
