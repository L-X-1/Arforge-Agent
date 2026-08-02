"""Behavioral tests for durable Graph orchestration above the Agent Loop."""

from __future__ import annotations

import sqlite3
import threading
import time

import pytest


def _definition(steps):
    from arforge.workflow_runtime import parse_workflow

    return parse_workflow(
        {
            "schema_version": 2,
            "name": "delivery_graph",
            "description": "A durable test graph.",
            "steps": steps,
        }
    )


def _wait_for(runtime, run_id, status, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = runtime.get_run(run_id)
        if run["status"] == status:
            return run
        time.sleep(0.01)
    raise AssertionError(f"workflow did not reach {status}: {runtime.get_run(run_id)}")


def test_graph_runs_independent_nodes_in_parallel_and_joins_dependencies(tmp_path):
    from arforge.workflow_graph_runtime import WorkflowGraphRuntime

    active = 0
    maximum = 0
    lock = threading.Lock()
    both_started = threading.Event()
    release = threading.Event()

    def runner(step, context):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
            if active == 2:
                both_started.set()
        if step.id in {"one", "two"}:
            assert both_started.wait(1)
            release.wait(1)
        with lock:
            active -= 1
        return f"{step.id}:{sorted(context['dependencies'])}"

    runtime = WorkflowGraphRuntime(tmp_path / "graph.db", runner)
    definition = _definition(
        [
            {"id": "one", "title": "One", "prompt": "one", "access": "read"},
            {"id": "two", "title": "Two", "prompt": "two", "access": "read"},
            {
                "id": "join",
                "title": "Join",
                "prompt": "join",
                "depends_on": ["one", "two"],
            },
        ]
    )
    created = runtime.create_run(
        definition,
        session_id="session-1",
        workspace=tmp_path,
        max_parallel=2,
    )
    runtime.start(created["run_id"])
    assert both_started.wait(1)
    release.set()
    run = runtime.wait(created["run_id"], 2)

    assert run["status"] == "completed"
    assert maximum == 2
    assert [node["status"] for node in run["nodes"]] == [
        "completed",
        "completed",
        "completed",
    ]
    assert "one" in run["nodes"][2]["output"]
    assert "two" in run["nodes"][2]["output"]


def test_graph_serializes_shared_workspace_writes_and_forces_reads_to_plan_mode(tmp_path):
    from arforge.workflow_graph_runtime import WorkflowGraphRuntime

    active_writes = 0
    maximum_writes = 0
    observed_modes = {}
    lock = threading.Lock()

    def runner(step, context):
        nonlocal active_writes, maximum_writes
        observed_modes[step.id] = context["permission_mode"]
        if step.access == "write":
            with lock:
                active_writes += 1
                maximum_writes = max(maximum_writes, active_writes)
            time.sleep(0.03)
            with lock:
                active_writes -= 1
        return "ok"

    runtime = WorkflowGraphRuntime(tmp_path / "graph.db", runner)
    run_id = runtime.create_run(
        _definition(
            [
                {"id": "write_one", "title": "Write one", "prompt": "write"},
                {"id": "write_two", "title": "Write two", "prompt": "write"},
                {
                    "id": "inspect",
                    "title": "Inspect",
                    "prompt": "inspect",
                    "depends_on": ["write_one", "write_two"],
                    "access": "read",
                },
            ]
        ),
        session_id="session-1",
        workspace=tmp_path,
        permission_mode="fullAccess",
        max_parallel=8,
    )["run_id"]
    runtime.start(run_id)
    assert runtime.wait(run_id, 2)["status"] == "completed"
    assert maximum_writes == 1
    assert observed_modes["write_one"] == "fullAccess"
    assert observed_modes["write_two"] == "fullAccess"
    assert observed_modes["inspect"] == "plan"


def test_graph_waits_for_explicit_approval_and_resumes_from_the_node(tmp_path):
    from arforge.workflow_graph_runtime import WorkflowGraphRuntime

    called = []
    runtime = WorkflowGraphRuntime(
        tmp_path / "graph.db",
        lambda step, _context: called.append(step.id) or "done",
    )
    definition = _definition(
        [
            {
                "id": "gate",
                "title": "Human gate",
                "kind": "approval",
                "prompt": "Approve deployment preparation.",
            },
            {
                "id": "after",
                "title": "After",
                "prompt": "Continue safely.",
                "depends_on": ["gate"],
            },
        ]
    )
    run_id = runtime.create_run(
        definition,
        session_id="session-1",
        workspace=tmp_path,
    )["run_id"]
    runtime.start(run_id)

    waiting = _wait_for(runtime, run_id, "waiting_approval")
    assert waiting["nodes"][0]["status"] == "waiting_approval"
    assert called == []

    runtime.decide_approval(run_id, "gate", approved=True, comment="Reviewed")
    completed = runtime.wait(run_id, 2)
    assert completed["status"] == "completed"
    assert completed["nodes"][0]["status"] == "approved"
    assert called == ["after"]


def test_graph_retries_nodes_and_applies_safe_status_conditions(tmp_path):
    from arforge.workflow_graph_runtime import WorkflowGraphRuntime

    attempts = {}

    def runner(step, _context):
        attempts[step.id] = attempts.get(step.id, 0) + 1
        if step.id == "unstable" and attempts[step.id] == 1:
            raise RuntimeError("temporary failure")
        return "ok"

    runtime = WorkflowGraphRuntime(tmp_path / "graph.db", runner)
    definition = _definition(
        [
            {
                "id": "unstable",
                "title": "Unstable",
                "prompt": "Try.",
                "max_attempts": 2,
            },
            {
                "id": "success_path",
                "title": "Success",
                "prompt": "Continue.",
                "depends_on": ["unstable"],
                "when": {"step": "unstable", "status": "completed"},
            },
            {
                "id": "failure_path",
                "title": "Failure",
                "prompt": "Recover.",
                "depends_on": ["unstable"],
                "when": {"step": "unstable", "status": "failed"},
            },
        ]
    )
    run_id = runtime.create_run(
        definition,
        session_id="session-1",
        workspace=tmp_path,
    )["run_id"]
    runtime.start(run_id)
    run = runtime.wait(run_id, 2)

    assert run["status"] == "completed"
    assert run["nodes"][0]["attempt"] == 2
    assert run["nodes"][1]["status"] == "completed"
    assert run["nodes"][2]["status"] == "skipped"
    event_types = [item["type"] for item in runtime.events(run_id)["items"]]
    assert "node.retrying" in event_types


def test_graph_retry_resets_failed_node_and_its_descendants_only(tmp_path):
    from arforge.workflow_graph_runtime import WorkflowGraphRuntime

    should_fail = {"broken": True}

    def runner(step, _context):
        if step.id == "broken" and should_fail["broken"]:
            raise RuntimeError("broken")
        return step.id

    runtime = WorkflowGraphRuntime(tmp_path / "graph.db", runner)
    definition = _definition(
        [
            {"id": "stable", "title": "Stable", "prompt": "stable"},
            {"id": "broken", "title": "Broken", "prompt": "broken"},
            {
                "id": "dependent",
                "title": "Dependent",
                "prompt": "dependent",
                "depends_on": ["broken"],
            },
        ]
    )
    run_id = runtime.create_run(
        definition,
        session_id="session-1",
        workspace=tmp_path,
    )["run_id"]
    runtime.start(run_id)
    failed = runtime.wait(run_id, 2)
    assert failed["status"] == "failed"
    assert [node["status"] for node in failed["nodes"]] == [
        "completed",
        "failed",
        "blocked",
    ]

    should_fail["broken"] = False
    runtime.retry_node(run_id, "broken")
    completed = runtime.wait(run_id, 2)
    assert completed["status"] == "completed"
    assert [node["status"] for node in completed["nodes"]] == [
        "completed",
        "completed",
        "completed",
    ]


def test_graph_marks_inflight_work_as_resumable_after_process_restart(tmp_path):
    from arforge.workflow_graph_runtime import WorkflowGraphRuntime

    path = tmp_path / "graph.db"
    runtime = WorkflowGraphRuntime(path, lambda step, context: "unused")
    run_id = runtime.create_run(
        _definition([{"id": "work", "title": "Work", "prompt": "work"}]),
        session_id="session-1",
        workspace=tmp_path,
    )["run_id"]
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE workflow_graph_runs SET status='running' WHERE run_id=?",
            (run_id,),
        )
        connection.execute(
            """
            UPDATE workflow_graph_nodes SET status='running'
            WHERE run_id=? AND node_id='work'
            """,
            (run_id,),
        )

    recovered = WorkflowGraphRuntime(path, lambda step, context: "recovered")
    run = recovered.get_run(run_id)
    assert run["status"] == "interrupted"
    assert run["nodes"][0]["status"] == "pending"

    recovered.resume(run_id)
    assert recovered.wait(run_id, 2)["status"] == "completed"


def test_second_runtime_preserves_active_lease_and_routes_control_to_owner(tmp_path):
    from arforge.workflow_graph_runtime import WorkflowGraphError, WorkflowGraphRuntime

    path = tmp_path / "graph.db"
    started = threading.Event()
    release = threading.Event()

    def runner(_step, _context):
        started.set()
        assert release.wait(2)
        return "done"

    owner = WorkflowGraphRuntime(path, runner, owner_id="owner-a")
    run_id = owner.create_run(
        _definition([{"id": "work", "title": "Work", "prompt": "work"}]),
        session_id="session-1",
        workspace=tmp_path,
    )["run_id"]
    owner.start(run_id)
    assert started.wait(1)

    observer = WorkflowGraphRuntime(path, lambda _step, _context: "unexpected", owner_id="owner-b")
    assert observer.get_run(run_id)["status"] == "running"
    with pytest.raises(WorkflowGraphError) as busy:
        observer.start(run_id)
    assert busy.value.code == "RUN_BUSY"

    requested = observer.pause(run_id)
    assert requested["status"] == "pause_requested"
    release.set()
    assert observer.wait(run_id, 2)["status"] == "paused"


def test_recovery_interrupts_only_expired_owner_leases(tmp_path):
    from arforge.workflow_graph_runtime import WorkflowGraphRuntime

    path = tmp_path / "graph.db"
    seed = WorkflowGraphRuntime(path, lambda _step, _context: "unused")
    definition = _definition([{"id": "work", "title": "Work", "prompt": "work"}])
    expired_id = seed.create_run(
        definition,
        session_id="expired",
        workspace=tmp_path,
    )["run_id"]
    active_id = seed.create_run(
        definition,
        session_id="active",
        workspace=tmp_path,
    )["run_id"]
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            UPDATE workflow_graph_runs
            SET status='running', lease_owner='dead-owner',
                lease_expires_at='2000-01-01T00:00:00Z'
            WHERE run_id=?
            """,
            (expired_id,),
        )
        connection.execute(
            """
            UPDATE workflow_graph_runs
            SET status='running', lease_owner='live-owner',
                lease_expires_at='2999-01-01T00:00:00Z'
            WHERE run_id=?
            """,
            (active_id,),
        )
        connection.execute(
            "UPDATE workflow_graph_nodes SET status='running' WHERE run_id IN (?, ?)",
            (expired_id, active_id),
        )

    recovered = WorkflowGraphRuntime(path, lambda _step, _context: "unused")
    assert recovered.get_run(expired_id)["status"] == "interrupted"
    assert recovered.get_run(expired_id)["nodes"][0]["status"] == "pending"
    assert recovered.get_run(active_id)["status"] == "running"
    assert recovered.get_run(active_id)["nodes"][0]["status"] == "running"


def test_default_store_uses_profile_sqlite_only_for_local_mode(monkeypatch, tmp_path):
    from arforge.workflow_graph_runtime import _default_store_target

    profile = tmp_path / "profile"
    monkeypatch.setenv("ARFORGE_HOME", str(profile))
    monkeypatch.setenv("ARFORGE_DB_URL", "sqlite:///:memory:")

    path, database_url, identity = _default_store_target()

    assert path == (profile / "workflows" / "graph-runs.sqlite3").resolve()
    assert database_url is None
    assert identity == f"sqlite:{path}"


def test_default_store_selects_postgresql_without_opening_a_connection(monkeypatch):
    from arforge.workflow_graph_runtime import _default_store_target

    configured = "postgresql://arforge_app:test@127.0.0.1:5432/arforge"
    monkeypatch.setenv("ARFORGE_DB_URL", configured)

    path, database_url, identity = _default_store_target()

    assert path is None
    assert database_url == configured
    assert identity.startswith("postgresql:")
    assert configured not in identity


def test_v2_workflow_validation_rejects_unsafe_conditions():
    from arforge.workflow_runtime import WorkflowValidationError, parse_workflow

    try:
        parse_workflow(
            {
                "schema_version": 2,
                "name": "unsafe_condition",
                "steps": [
                    {"id": "one", "prompt": "one"},
                    {
                        "id": "two",
                        "prompt": "two",
                        "depends_on": ["one"],
                        "when": {"step": "one", "status": "__import__('os')"},
                    },
                ],
            }
        )
    except WorkflowValidationError as exc:
        assert "supported terminal statuses" in str(exc)
    else:
        raise AssertionError("unsafe condition must be rejected")
