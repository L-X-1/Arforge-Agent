"""Adapters converge existing planning and verification views into Agent IR."""

from __future__ import annotations


def test_task_ledger_plan_imports_as_plan_actions_without_parallel_planner():
    from arforge.core.cognitive_adapters import import_task_ledger
    from arforge.core.cognitive_ir import Action, AgentTaskIR
    from arforge.core.task_ledger import COMPLETED, IN_PROGRESS, PENDING, TaskItem, TaskLedger

    ledger = TaskLedger()
    ledger.replace(
        [
            TaskItem("Inspect cache entry", PENDING),
            TaskItem("Patch resolver", IN_PROGRESS),
            TaskItem("Run target test", COMPLETED),
        ]
    )
    task = AgentTaskIR.create("Repair cache", task_id="task-ledger")

    imported = import_task_ledger(task, ledger)

    actions = [record for record in imported.records if isinstance(record, Action)]
    assert [action.record_id for action in actions] == ["plan-step-0001", "plan-step-0002", "plan-step-0003"]
    assert [action.target for action in actions] == [
        "Inspect cache entry",
        "Patch resolver",
        "Run target test",
    ]
    assert [action.status for action in actions] == [PENDING, IN_PROGRESS, COMPLETED]
    assert all(action.action_type == "plan_step" for action in actions)


def test_agent_ir_plan_actions_export_into_the_existing_task_ledger():
    from arforge.core.cognitive_adapters import sync_task_ledger
    from arforge.core.cognitive_ir import Action, AgentTaskIR
    from arforge.core.task_ledger import TaskLedger

    task = AgentTaskIR.create("Repair cache", task_id="task-export")
    task = task.with_record(
        Action(
            record_id="plan-step-1",
            action_type="plan_step",
            target="Inspect",
            status="completed",
        )
    ).with_record(
        Action(
            record_id="tool-action-1",
            action_type="run_test",
            target="tests/cache_test.py",
            status="completed",
        )
    )
    ledger = TaskLedger()

    sync_task_ledger(task, ledger)

    assert ledger.to_list() == [{"content": "Inspect", "status": "completed"}]


def test_run_result_verifications_become_evidence_linked_typed_records():
    from arforge.core.cognitive_adapters import import_run_verifications
    from arforge.core.cognitive_ir import AgentTaskIR, Evidence, Verification

    task = AgentTaskIR.create("Verify patch", task_id="task-verification")
    imported = import_run_verifications(
        task,
        [
            {
                "tool": "run_tests",
                "passed": True,
                "step": 4,
                "criterion": "Target tests pass",
                "command": "pytest tests/cache_test.py",
            },
            {"tool": "type_check", "passed": False, "step": 5},
        ],
    )

    evidence = [record for record in imported.records if isinstance(record, Evidence)]
    verifications = [record for record in imported.records if isinstance(record, Verification)]
    assert len(evidence) == 2
    assert len(verifications) == 2
    assert verifications[0].criterion == "Target tests pass"
    assert verifications[0].status == "passed"
    assert verifications[0].evidence_ids == (evidence[0].record_id,)
    assert verifications[1].criterion == "type_check succeeds"
    assert verifications[1].status == "failed"
    assert evidence[0].source == "run_result:run_tests"
    assert evidence[0].extensions["arforge.run_result"]["step"] == 4
    assert evidence[0].extensions["arforge.run_result"]["command"] == "pytest tests/cache_test.py"


def test_adapter_allocates_new_ids_when_a_run_result_is_imported_twice():
    from arforge.core.cognitive_adapters import import_run_verifications
    from arforge.core.cognitive_ir import AgentTaskIR, Verification

    task = AgentTaskIR.create("Verify patch", task_id="task-repeat")
    task = import_run_verifications(task, [{"tool": "run_tests", "passed": True}])
    task = import_run_verifications(task, [{"tool": "run_tests", "passed": True}])

    ids = [record.record_id for record in task.records if isinstance(record, Verification)]
    assert ids == ["run-verification-0001", "run-verification-0002"]
