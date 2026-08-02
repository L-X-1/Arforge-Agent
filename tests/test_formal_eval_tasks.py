from __future__ import annotations

from pathlib import Path

from arforge.eval.formal_tasks import builtin_formal_tasks
from arforge.eval.multistack_formal_tasks import (
    SCENARIOS,
    builtin_multistack_formal_tasks,
)


def test_formal_suite_has_fifty_unique_cross_category_tasks():
    tasks = builtin_formal_tasks()

    assert len(tasks) == 50
    assert len({task.task_id for task in tasks}) == 50
    assert {task.category for task in tasks} == {
        "bug_fix",
        "feature_add",
        "data_processing",
        "test_write",
        "multi_file",
        "refactor",
        "architecture_qa",
    }
    assert all(task.timeout_steps == 30 for task in tasks)
    assert all(task.setup is not None and task.verify is not None for task in tasks)


def test_formal_fixture_starts_unaccepted_and_requires_regression_test(tmp_path):
    task = builtin_formal_tasks()[0]
    task.setup(tmp_path)

    assert (tmp_path / "pyproject.toml").is_file()
    assert (tmp_path / "tests/test_contract.py").is_file()
    assert not (tmp_path / "tests/test_regression.py").exists()
    assert task.verify(tmp_path) is False


def test_multistack_formal_suite_has_fifty_tasks_across_ten_toolchains():
    tasks = builtin_multistack_formal_tasks()

    assert len(tasks) == 50
    assert len({task.task_id for task in tasks}) == 50
    assert len(SCENARIOS) == 10
    assert {task.category for task in tasks} == {
        f"cross_language_{scenario.stack_id}" for scenario in SCENARIOS
    }
    assert all(task.prompt.startswith("修复这个 ") for task in tasks)
    assert all(
        "不能把它写死" in task.prompt or "数据库自身约束" in task.prompt
        for task in tasks
    )
    assert all(task.timeout_steps == 40 for task in tasks)
    native_prompts = [
        task.prompt
        for task in tasks
        if task.category in {"cross_language_c", "cross_language_cpp"}
    ]
    assert native_prompts
    assert all(r".\contract.exe" in prompt for prompt in native_prompts)


def test_multistack_fixtures_fail_closed_until_regression_exists(tmp_path):
    for index, scenario in enumerate(SCENARIOS, start=1):
        workspace = tmp_path / scenario.stack_id
        workspace.mkdir()
        scenario.setup(workspace, 51 + index, 101 + index)

        assert not (workspace / scenario.regression_path).exists()
        assert scenario.verify(workspace) is False


def test_sql_verifier_accepts_sqlite_cli_directives_in_regression(tmp_path):
    scenario = next(item for item in SCENARIOS if item.stack_id == "sql")
    scenario.setup(tmp_path, 54, 102)
    schema = tmp_path / "src/schema.sql"
    schema.write_text(
        schema.read_text(encoding="utf-8").replace(
            "CHECK (maximum >= threshold)\n);",
            "CHECK (maximum >= threshold),\n  CHECK (maximum <= 1000)\n);",
        ),
        encoding="utf-8",
    )
    regression = tmp_path / scenario.regression_path
    regression.write_text(
        ".bail on\n"
        "INSERT INTO score_policy(id, threshold, maximum) VALUES (2, 0, 1000);\n",
        encoding="utf-8",
    )

    assert scenario.verify(tmp_path) is True


def test_remote_formal_and_staging_workflows_are_manual_cost_gates():
    formal = Path(".github/workflows/formal-eval.yml").read_text(encoding="utf-8")
    reusable = Path(".github/workflows/reusable-formal-eval.yml").read_text(
        encoding="utf-8"
    )
    staging = Path(".github/workflows/reusable-staging-validation.yml").read_text(
        encoding="utf-8"
    )

    assert "workflow_dispatch:" in formal
    assert "schedule:" not in formal
    assert "suite: formal" in formal
    assert "suite: formal-multistack" in formal
    assert "ARFORGE_EVAL_TOKEN_BUDGET" in reusable
    assert "postgres:17" in reusable
    assert "environment: staging" in staging
    assert "--requests 100" in staging
    assert "--duration-minutes 15" in staging
