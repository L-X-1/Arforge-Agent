def test_quick_plan_and_format():
    from arforge.planning.planner import format_plan_display, quick_plan

    plan = quick_plan("rebuild planning layer")
    rendered = format_plan_display(plan)

    assert plan.steps
    assert "rebuild planning layer" in rendered


def test_reasoning_and_orchestration():
    from arforge.planning.orchestrator import orchestrate_task
    from arforge.planning.reasoning import reason_about_task

    reasoning = reason_about_task("fix failing tests")
    result = orchestrate_task("fix failing tests")

    assert reasoning["category"] == "fix"
    assert result.plan.steps
    assert result.reasoning["needs_tests"]


def test_workflow_runs_steps():
    from arforge.planning.workflow import WorkflowStep, run_workflow

    result = run_workflow([WorkflowStep("one", lambda: 1)])

    assert result.success
    assert result.steps[0].result == 1
