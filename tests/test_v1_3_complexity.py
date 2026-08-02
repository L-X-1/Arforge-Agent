"""v1-1.3 动态 max_steps（complexity）测试。"""

from __future__ import annotations

from arforge.core.complexity import (
    COMPLEX_STEPS,
    MEDIUM_STEPS,
    SIMPLE_STEPS,
    estimate_max_steps,
)


def test_simple_short_task():
    assert estimate_max_steps("print hello") == SIMPLE_STEPS


def test_empty_or_none_task():
    assert estimate_max_steps("") == SIMPLE_STEPS
    assert estimate_max_steps(None) == SIMPLE_STEPS


def test_medium_keyword():
    assert estimate_max_steps("实现一个登录功能") == MEDIUM_STEPS
    assert estimate_max_steps("fix the bug in parser") == MEDIUM_STEPS


def test_complex_keyword():
    assert estimate_max_steps("重构整个项目的模块结构") == COMPLEX_STEPS
    assert estimate_max_steps("refactor all files across the repo") == COMPLEX_STEPS
    assert estimate_max_steps("继续运行验收直到完整可玩") == COMPLEX_STEPS


def test_long_text_escalates():
    assert estimate_max_steps("x" * 100) == MEDIUM_STEPS  # 长 → 中等
    assert estimate_max_steps("y" * 250) == COMPLEX_STEPS  # 超长 → 复杂


def test_complex_beats_medium():
    assert estimate_max_steps("实现并重构整个架构") == COMPLEX_STEPS


def test_ordering_invariant():
    assert SIMPLE_STEPS < MEDIUM_STEPS < COMPLEX_STEPS
    assert COMPLEX_STEPS == 80


def test_agent_loop_classifier_understands_chinese_development_tasks():
    from arforge.core.task_complexity import ComplexityTier, estimate_complexity

    assert estimate_complexity("修复登录错误") is ComplexityTier.MEDIUM
    assert estimate_complexity("重构整个项目的多文件架构") is ComplexityTier.COMPLEX
    assert estimate_complexity("解释什么是递归") is ComplexityTier.SIMPLE
