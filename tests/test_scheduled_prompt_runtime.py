from __future__ import annotations

from datetime import datetime

import pytest

from arforge.bridge import dispatch
from arforge.product.session_runtime import SessionRuntime
from arforge.scheduled_prompt_runtime import (
    ScheduledPromptError,
    ScheduledPromptManager,
    next_cron_run,
    parse_cron,
)


class MutableClock:
    def __init__(self, value: float):
        self.value = value

    def __call__(self) -> float:
        return self.value


class QuietAgent:
    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, _value: str):
        yield {"type": "answer_delta", "data": {"content": "done"}}
        yield {"type": "done", "data": {}}


def test_cron_parser_supports_standard_subset_and_dom_dow_or_semantics():
    assert parse_cron("*/5 8-18 * * 1-5") is not None
    assert parse_cron("0 9 * * 7") is not None
    assert parse_cron("0 9 * * MON") is None
    assert parse_cron("0 9 * *") is None

    anchor = datetime(2026, 7, 16, 8, 59).timestamp()
    next_run = next_cron_run("0 9 17 * 5", anchor)
    assert next_run is not None
    local = datetime.fromtimestamp(next_run)
    assert local.hour == 9
    assert local.minute == 0
    assert local.day == 17 or (local.weekday() + 1) % 7 == 5


def test_session_only_one_shot_dispatches_once(tmp_path):
    clock = MutableClock(datetime(2026, 7, 16, 10, 0).timestamp())
    manager = ScheduledPromptManager(tmp_path / "schedule.json", clock=clock)
    created = manager.create(
        "session-1",
        "1 10 16 7 *",
        "check the deployment",
        recurring=False,
    )
    fired: list[dict] = []
    manager._on_fire = lambda job: fired.append(job) is None or True

    clock.value = created["next_fire_at"] + 1
    manager._tick()

    assert [item["prompt"] for item in fired] == ["check the deployment"]
    assert manager.list("session-1") == []


def test_recurring_job_reschedules_and_survives_restart(tmp_path):
    clock = MutableClock(datetime(2026, 7, 16, 10, 0).timestamp())
    path = tmp_path / "schedule.json"
    manager = ScheduledPromptManager(path, clock=clock)
    created = manager.create(
        "session-1",
        "* * * * *",
        "inspect the queue",
        recurring=True,
        durable=True,
    )
    manager._owns_durable_dispatch = True
    manager._on_fire = lambda _job: True
    clock.value = created["next_fire_at"] + 1
    manager._tick()

    jobs = manager.list("session-1")
    assert len(jobs) == 1
    assert jobs[0]["last_fired_at"] == clock.value
    assert jobs[0]["next_fire_at"] > clock.value

    recovered = ScheduledPromptManager(path, clock=clock)
    assert recovered.list("session-1")[0]["id"] == created["id"]


def test_missed_durable_one_shot_requires_explicit_consumption(tmp_path):
    clock = MutableClock(datetime(2026, 7, 16, 10, 0).timestamp())
    path = tmp_path / "schedule.json"
    creator = ScheduledPromptManager(path, clock=clock)
    created = creator.create(
        "session-1",
        "1 10 16 7 *",
        "run the smoke test",
        recurring=False,
        durable=True,
    )
    clock.value = created["next_fire_at"] + 60

    recovered = ScheduledPromptManager(path, clock=clock)
    recovered._owns_durable_dispatch = True
    recovered._prepare_startup()

    missed = recovered.list("session-1")
    assert missed[0]["status"] == "missed"
    consumed = recovered.consume_for_current_turn("session-1", created["id"])
    assert consumed["prompt"] == "run the smoke test"
    assert recovered.list("session-1") == []


def test_jobs_are_session_owned(tmp_path):
    manager = ScheduledPromptManager(tmp_path / "schedule.json")
    job = manager.create("owner", "* * * * *", "hello")

    with pytest.raises(ScheduledPromptError, match="another session"):
        manager.delete("other", job["id"])


def test_durable_dispatch_has_one_process_owner(tmp_path):
    path = tmp_path / "schedule.json"
    first = ScheduledPromptManager(path)
    second = ScheduledPromptManager(path)

    first._acquire_owner()
    second._acquire_owner()

    assert first._owns_durable_dispatch is True
    assert second._owns_durable_dispatch is False
    first._release_owner()
    second._acquire_owner()
    assert second._owns_durable_dispatch is True
    second._release_owner()


def test_state_lock_recovers_immediately_when_owner_process_exited(tmp_path, monkeypatch):
    import arforge.scheduled_prompt_runtime as scheduled_runtime

    manager = ScheduledPromptManager(tmp_path / "schedule.json")
    manager.lock_path.write_text("424242 0\n", encoding="ascii")
    monkeypatch.setattr(scheduled_runtime, "_process_is_alive", lambda _pid: False)

    with manager._state_lock():
        assert manager.lock_path.exists()

    assert not manager.lock_path.exists()


def test_bridge_exposes_schedule_lifecycle(tmp_path):
    manager = ScheduledPromptManager(tmp_path / "schedule.json")
    runtime = SessionRuntime(
        lambda _event: None,
        agent_factory=QuietAgent,
        scheduler=manager,
    )
    session = runtime.create_session()
    created = dispatch(
        {
            "version": "1.2",
            "method": "schedule.create",
            "params": {
                "session_id": session["session_id"],
                "cron": "* * * * *",
                "prompt": "review status",
                "recurring": True,
                "durable": True,
            },
        },
        runtime=runtime,
    )
    assert created["ok"] is True

    listed = dispatch(
        {
            "version": "1.2",
            "method": "schedule.list",
            "params": {"session_id": session["session_id"]},
        },
        runtime=runtime,
    )
    assert listed["data"]["count"] == 1

    deleted = dispatch(
        {
            "version": "1.2",
            "method": "schedule.delete",
            "params": {
                "session_id": session["session_id"],
                "job_id": created["data"]["id"],
            },
        },
        runtime=runtime,
    )
    assert deleted["ok"] is True
    invalid = dispatch(
        {
            "version": "1.2",
            "method": "schedule.create",
            "params": {
                "session_id": session["session_id"],
                "cron": "* * * * *",
                "prompt": "review status",
                "recurring": "false",
            },
        },
        runtime=runtime,
    )
    assert invalid["ok"] is False
    assert invalid["error"]["code"] == "INVALID_PARAMS"
    described = dispatch({"version": "1.2", "method": "protocol.describe"})
    assert "schedule.create" in described["data"]["methods"]
