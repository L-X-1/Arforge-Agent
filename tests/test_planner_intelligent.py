"""Test A5: Model-driven intelligent planning — no more hardcoded 5-step template.

Verifies that:
- generate_task_plan uses task-type-aware templates offline (question/coding/analysis/general)
- Model-driven path parses LLM JSON output correctly (when model provided)
- _detect_task_type classifies goals into correct categories
- _parse_plan_json handles valid JSON, missing brackets, invalid structure
- quick_plan_with_model creates plan (falls back offline when model unavailable)
"""

from __future__ import annotations



from arforge.planning.planner import (
    generate_task_plan,
    quick_plan,
    quick_plan_with_model,
    format_plan_display,
    ExecutionPlan,
    PlanStep,
    _detect_task_type,
    _parse_plan_json,
)


# ====================================================================
# _detect_task_type tests
# ====================================================================


class TestDetectTaskType:
    def test_question_type_for_what_is(self):
        assert _detect_task_type("法国首都是什么") == "question"
        assert _detect_task_type("什么是Python装饰器") == "question"

    def test_question_type_for_how_to(self):
        assert _detect_task_type("如何优化数据库查询") == "question"
        assert _detect_task_type("how to implement caching") == "question"

    def test_question_type_for_why(self):
        assert _detect_task_type("why is this code slow") == "question"
        assert _detect_task_type("为什么这段代码报错") == "question"

    def test_question_type_with_question_mark(self):
        assert _detect_task_type("这个bug怎么修？") == "question"

    def test_coding_type_for_fix_bug(self):
        assert _detect_task_type("修复 memory.py 的 bug") == "coding"
        assert _detect_task_type("fix the login bug") == "coding"

    def test_coding_type_for_implement(self):
        assert _detect_task_type("实现用户认证功能") == "coding"
        assert _detect_task_type("implement cache layer") == "coding"

    def test_coding_type_for_refactor(self):
        assert _detect_task_type("重构 agent_core.py 的路由逻辑") == "coding"

    def test_analysis_type_for_review(self):
        assert _detect_task_type("审查 cli.py 的安全性") == "analysis"
        assert _detect_task_type("分析性能瓶颈") == "analysis"

    def test_analysis_type_for_audit(self):
        assert _detect_task_type("审计代码中的安全漏洞") == "analysis"

    def test_general_type_for_vague_input(self):
        assert _detect_task_type("hello world") == "general"
        assert _detect_task_type("帮我一下") == "general"


# ====================================================================
# generate_task_plan offline tests
# ====================================================================


class TestGenerateTaskPlanOffline:
    """Tests for generate_task_plan with model=None (offline templates)."""

    def test_question_uses_question_template(self):
        """法国首都是什么 → should NOT return 代码变更 steps."""
        steps = generate_task_plan("法国首都是什么")
        assert len(steps) > 0
        # Should contain understanding/explanation steps, NOT code steps
        joined = " ".join(steps).lower()
        assert "理解" in joined
        # Should NOT contain code-specific actions
        assert "编译" not in joined
        assert "compile" not in joined
        assert "lint" not in joined

    def test_coding_includes_specific_steps(self):
        """修复 bug → should include code-specific actions."""
        steps = generate_task_plan("修复 memory.py 的 dedupe bug")
        joined = " ".join(steps).lower()
        assert "定位" in joined or "文件" in joined
        assert "验证" in joined or "测试" in joined or "lint" in joined

    def test_analysis_uses_analysis_template(self):
        """审查 → should include analysis-specific steps."""
        steps = generate_task_plan("审查 cli.py 的安全性")
        joined = " ".join(steps).lower()
        assert "分析" in joined or "检查" in joined or "收集" in joined

    def test_general_uses_general_template(self):
        """Vague input → general template."""
        steps = generate_task_plan("帮我想个方案")
        assert len(steps) > 0
        # General template has at least task understanding
        joined = " ".join(steps)
        assert "理解" in joined or "目标" in joined

    def test_empty_goal_returns_empty(self):
        assert generate_task_plan("") == []
        assert generate_task_plan("   ") == []

    def test_different_task_types_return_different_steps(self):
        """Different task types must return DIFFERENT step sets."""
        question_steps = generate_task_plan("什么是闭包")
        coding_steps = generate_task_plan("修复闭包的bug")
        analysis_steps = generate_task_plan("分析闭包的性能")

        # They should all be non-empty but different from each other
        assert len(question_steps) > 0
        assert len(coding_steps) > 0
        assert len(analysis_steps) > 0

        # Coding and question should differ (coding has compile/lint/etc)
        assert question_steps != coding_steps, f"Question and coding should differ: {question_steps} vs {coding_steps}"


# ====================================================================
# _parse_plan_json tests
# ====================================================================


class TestParsePlanJson:
    def test_parse_valid_json_array(self):
        raw = '[{"title": "分析需求", "detail": "读代码", "risk": "低"}, {"title": "实现功能", "detail": "写代码", "risk": "中"}]'
        result = _parse_plan_json(raw)
        assert result is not None
        assert len(result) == 2
        assert result[0]["title"] == "分析需求"
        assert result[1]["title"] == "实现功能"

    def test_parse_json_with_surrounding_text(self):
        raw = '好的，这是计划：\n[{"title": "步骤1", "detail": "做A", "risk": "低"}]\n希望有帮助。'
        result = _parse_plan_json(raw)
        assert result is not None
        assert len(result) == 1
        assert result[0]["title"] == "步骤1"

    def test_parse_missing_title_field_returns_none(self):
        raw = '[{"detail": "no title here", "risk": "低"}]'
        result = _parse_plan_json(raw)
        assert result is None

    def test_parse_not_a_list_returns_none(self):
        raw = '{"title": "not a list"}'
        result = _parse_plan_json(raw)
        assert result is None

    def test_parse_no_brackets_returns_none(self):
        result = _parse_plan_json("no json here at all")
        assert result is None

    def test_parse_malformed_json_returns_none(self):
        result = _parse_plan_json('[{"title": "broken",}')
        assert result is None


# ====================================================================
# quick_plan tests
# ====================================================================


class TestQuickPlan:
    def test_quick_plan_offline_produces_execution_plan(self):
        plan = quick_plan("修复一个bug")
        assert isinstance(plan, ExecutionPlan)
        assert len(plan.steps) > 0
        assert plan.goal == "修复一个bug"

    def test_quick_plan_with_model_none(self):
        plan = quick_plan("审查代码", model=None)
        assert isinstance(plan, ExecutionPlan)
        # Should use analysis template
        joined = " ".join(s.title for s in plan.steps).lower()
        assert "分析" in joined or "检查" in joined

    def test_quick_plan_has_correct_step_ids(self):
        plan = quick_plan("测试任务")
        for i, step in enumerate(plan.steps):
            assert step.id == i + 1

    def test_quick_plan_steps_have_pending_status(self):
        plan = quick_plan("任意任务")
        for step in plan.steps:
            assert step.status == "pending"


# ====================================================================
# quick_plan_with_model tests
# ====================================================================


class TestQuickPlanWithModel:
    def test_does_not_crash_when_model_unavailable(self):
        """quick_plan_with_model should fall back to offline templates."""
        # This may or may not have a real API key configured.
        # It must never crash — always return an ExecutionPlan.
        plan = quick_plan_with_model("修复 cli.py 的退出码问题")
        assert isinstance(plan, ExecutionPlan)
        assert len(plan.steps) > 0


# ====================================================================
# format_plan_display tests
# ====================================================================


class TestFormatPlanDisplay:
    def test_format_includes_goal(self):
        plan = quick_plan("测试目标")
        output = format_plan_display(plan)
        assert "测试目标" in output

    def test_format_includes_steps(self):
        plan = quick_plan("审查代码")
        output = format_plan_display(plan)
        assert "1." in output
        assert "[pending]" in output

    def test_format_with_risks(self):
        plan = ExecutionPlan(
            goal="有风险的任务",
            steps=[PlanStep(id=1, title="高危步骤", risk="数据丢失")],
            risks=["数据丢失", "性能下降"],
        )
        output = format_plan_display(plan)
        assert "⚠️" in output
        assert "数据丢失" in output


# ====================================================================
# PlanStep / ExecutionPlan dataclass tests
# ====================================================================


def test_plan_step_has_risk_field():
    step = PlanStep(id=1, title="测试", risk="高")
    assert step.risk == "高"


def test_execution_plan_to_markdown_multiline():
    plan = ExecutionPlan(
        goal="复杂任务",
        steps=[
            PlanStep(id=1, title="步骤1", detail="详细信息", risk="低"),
            PlanStep(id=2, title="步骤2"),
        ],
    )
    md = plan.to_markdown()
    assert "# Plan:" in md
    assert "详细信息" in md
    assert "2." in md
