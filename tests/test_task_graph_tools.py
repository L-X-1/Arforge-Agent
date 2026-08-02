from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from arforge.core.hooks import HookDecision, HookEvent, get_hook_manager, reset_hook_manager
from arforge.tools import task_tools


@pytest.fixture(autouse=True)
def isolated_profile(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    reset_hook_manager()
    yield
    reset_hook_manager()


def test_legacy_task_list_is_normalized_without_changing_storage_shape():
    path = task_tools._task_file()
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            [
                {
                    "id": 4,
                    "title": "legacy",
                    "priority": "high",
                    "tag": "",
                    "status": "pending",
                    "created_at": "2026-01-01T00:00:00",
                }
            ]
        ),
        encoding="utf-8",
    )

    task = task_tools.get_task(4)

    assert task is not None
    assert task["blocks"] == []
    assert task["blocked_by"] == []
    created = task_tools.create_task("next")
    assert created["id"] == 5
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(stored, list)
    assert stored[0]["title"] == "legacy"


def test_highwater_prevents_id_reuse_after_delete():
    first = task_tools.create_task("first")
    assert task_tools.delete_task(first["id"])

    second = task_tools.create_task("second")

    assert second["id"] == first["id"] + 1


def test_dependency_relations_are_symmetric_and_cycles_are_rejected():
    first = task_tools.create_task("first")
    second = task_tools.create_task("second")
    third = task_tools.create_task("third")

    task_tools.update_task(first["id"], add_blocks=[second["id"]])
    task_tools.update_task(third["id"], add_blocked_by=[second["id"]])

    assert task_tools.get_task(first["id"])["blocks"] == [second["id"]]
    assert task_tools.get_task(second["id"])["blocked_by"] == [first["id"]]
    assert task_tools.get_task(second["id"])["blocks"] == [third["id"]]
    assert task_tools.get_task(third["id"])["blocked_by"] == [second["id"]]
    with pytest.raises(task_tools.TaskStoreError, match="cycle"):
        task_tools.update_task(third["id"], add_blocks=[first["id"]])


def test_delete_and_clear_completed_remove_dependency_references():
    blocker = task_tools.create_task("blocker")
    blocked = task_tools.create_task("blocked")
    task_tools.update_task(blocker["id"], add_blocks=[blocked["id"]])

    assert task_tools.delete_task(blocker["id"])
    assert task_tools.get_task(blocked["id"])["blocked_by"] == []

    completed = task_tools.create_task("completed")
    remaining = task_tools.create_task("remaining")
    task_tools.update_task(completed["id"], add_blocks=[remaining["id"]])
    task_tools.complete_task(completed["id"])
    task_tools.clear_completed()
    assert task_tools.get_task(remaining["id"])["blocked_by"] == []


def test_claim_enforces_dependencies_owner_conflicts_and_owner_capacity():
    blocker = task_tools.create_task("blocker")
    blocked = task_tools.create_task("blocked")
    task_tools.update_task(blocked["id"], add_blocked_by=[blocker["id"]])

    with pytest.raises(task_tools.TaskStoreError, match="blocked by"):
        task_tools.claim_task(blocked["id"], "worker-a")

    task_tools.complete_task(blocker["id"])
    claimed = task_tools.claim_task(blocked["id"], "worker-a")
    assert claimed["status"] == "in_progress"
    assert claimed["owner"] == "worker-a"

    other = task_tools.create_task("other")
    with pytest.raises(task_tools.TaskStoreError, match="already working"):
        task_tools.claim_task(other["id"], "worker-a")
    with pytest.raises(task_tools.TaskStoreError, match="already owned"):
        task_tools.claim_task(blocked["id"], "worker-b")


@pytest.mark.parametrize(
    "blocker_status", ["pending", "in_progress", "failed", "cancelled"]
)
def test_status_updates_cannot_bypass_unresolved_dependencies(blocker_status: str):
    blocker = task_tools.create_task("blocker")
    blocked = task_tools.create_task("blocked")
    task_tools.update_task(blocked["id"], add_blocked_by=[blocker["id"]])
    if blocker_status != "pending":
        task_tools.update_task(blocker["id"], status=blocker_status)

    with pytest.raises(
        task_tools.TaskStoreError, match=rf"blocked by #{blocker['id']}"
    ):
        task_tools.update_task(blocked["id"], status="in_progress")
    with pytest.raises(
        task_tools.TaskStoreError, match=rf"blocked by #{blocker['id']}"
    ):
        task_tools.complete_task(blocked["id"])

    assert task_tools.get_task(blocked["id"])["status"] == "pending"


def test_rejected_blocked_completion_does_not_fire_completion_hook():
    blocker = task_tools.create_task("blocker")
    blocked = task_tools.create_task("blocked")
    task_tools.update_task(blocked["id"], add_blocked_by=[blocker["id"]])
    observed: list[int] = []
    get_hook_manager().register(
        HookEvent.TASK_COMPLETED,
        lambda context: observed.append(context.metadata["task"]["id"]) or HookDecision.proceed(),
    )

    with pytest.raises(task_tools.TaskStoreError, match=rf"blocked by #{blocker['id']}"):
        task_tools.complete_task(blocked["id"])

    assert observed == []


def test_graph_mutations_cannot_leave_active_or_completed_tasks_blocked():
    blocker = task_tools.create_task("blocker")
    blocked = task_tools.create_task("blocked")
    task_tools.update_task(blocked["id"], add_blocked_by=[blocker["id"]])
    task_tools.complete_task(blocker["id"])
    task_tools.complete_task(blocked["id"])

    with pytest.raises(
        task_tools.TaskStoreError, match=rf"blocked by #{blocker['id']}"
    ):
        task_tools.update_task(blocker["id"], status="pending")

    assert task_tools.get_task(blocker["id"])["status"] == "completed"
    assert task_tools.get_task(blocked["id"])["status"] == "completed"

    unresolved = task_tools.create_task("unresolved")
    independent = task_tools.create_task("independent")
    task_tools.complete_task(independent["id"])
    with pytest.raises(
        task_tools.TaskStoreError, match=rf"blocked by #{unresolved['id']}"
    ):
        task_tools.update_task(independent["id"], add_blocked_by=[unresolved["id"]])
    assert task_tools.get_task(independent["id"])["blocked_by"] == []


def test_cancel_and_failure_states_require_an_explicit_reopen():
    task = task_tools.create_task("recoverable")

    cancelled = task_tools.cancel_task(task["id"])
    assert cancelled is not None
    assert cancelled["status"] == "cancelled"
    with pytest.raises(task_tools.TaskStoreError, match="must be reopened"):
        task_tools.claim_task(task["id"], "worker-a")
    with pytest.raises(task_tools.TaskStoreError, match="invalid status transition"):
        task_tools.complete_task(task["id"])

    reopened = task_tools.update_task(task["id"], status="pending")
    assert reopened is not None
    failed = task_tools.update_task(task["id"], status="failed")
    assert failed is not None
    assert failed["status"] == "failed"
    with pytest.raises(task_tools.TaskStoreError, match="invalid status transition"):
        task_tools.update_task(task["id"], status="in_progress")

    assert task_tools.get_task(task["id"])["status"] == "failed"


def test_metadata_merge_redaction_and_null_delete():
    task = task_tools.create_task(
        "metadata",
        metadata={"token": "sk-test-secret", "keep": "yes"},
    )
    updated = task_tools.update_task(
        task["id"],
        metadata={"token": None, "nested": {"authorization": "Bearer private"}},
    )

    assert updated["metadata"]["keep"] == "yes"
    assert "token" not in updated["metadata"]
    assert "private" not in updated["metadata"]["nested"]["authorization"]


def test_task_hooks_can_block_create_and_complete_without_persisting():
    manager = get_hook_manager()
    manager.register(
        HookEvent.TASK_CREATED,
        lambda _ctx: HookDecision.block("creation policy"),
    )
    with pytest.raises(task_tools.TaskStoreError, match="creation policy"):
        task_tools.create_task("blocked")
    assert task_tools.list_tasks() == []

    manager.clear()
    task = task_tools.create_task("allowed")
    manager.register(
        HookEvent.TASK_COMPLETED,
        lambda _ctx: HookDecision.ask("completion approval"),
    )
    with pytest.raises(task_tools.TaskStoreError, match="completion approval"):
        task_tools.complete_task(task["id"])
    assert task_tools.get_task(task["id"])["status"] == "pending"


def test_registered_graph_tools_execute_with_structured_arguments():
    from arforge.tool_executor import execute_tool_by_name, get_tool

    first = execute_tool_by_name("create_task", {"title": "first"})
    second = execute_tool_by_name("create_task", {"title": "second"})
    assert first.success and second.success
    first_id = int(first.output.split("#", 1)[1].split(":", 1)[0])
    second_id = int(second.output.split("#", 1)[1].split(":", 1)[0])

    updated = execute_tool_by_name(
        "update_task",
        {"task_id": first_id, "add_blocks": json.dumps([second_id])},
    )
    details = execute_tool_by_name("get_task", {"task_id": second_id})
    cancelled = execute_tool_by_name("cancel_task", {"task_id": second_id})

    assert updated.success
    assert details.success
    assert cancelled.success
    assert f"Cancelled #{second_id}" in cancelled.output
    assert first_id in json.loads(details.output)["blocked_by"]
    assert get_tool("claim_task") is not None
    assert get_tool("cancel_task") is not None


def test_concurrent_creates_use_unique_monotonic_ids():
    with ThreadPoolExecutor(max_workers=8) as pool:
        tasks = list(pool.map(lambda index: task_tools.create_task(f"task-{index}"), range(24)))

    ids = sorted(task["id"] for task in tasks)
    assert ids == list(range(1, 25))
    assert len(task_tools.list_tasks()) == 24
