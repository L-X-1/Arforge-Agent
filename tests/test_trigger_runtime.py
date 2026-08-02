"""Provider-neutral trigger lifecycle and credential-isolation tests."""

from __future__ import annotations

import io
import json
import time
from datetime import datetime
from urllib.error import URLError

import pytest

from arforge.bridge import dispatch
from arforge.mcp_client_runtime import EnvironmentTokenProvider
from arforge.product.session_runtime import SessionRuntime
from arforge.scheduled_prompt_runtime import ScheduledPromptManager
from arforge.trigger_runtime import (
    MAX_TRIGGER_BODY_BYTES,
    TriggerManager,
    TriggerProfile,
    TriggerRuntimeError,
    profiles_from_environment,
)


class MutableClock:
    def __init__(self, value: float):
        self.value = value

    def __call__(self) -> float:
        return self.value


class FakeResponse:
    def __init__(self, payload, status=200):
        self.status = status
        self.code = status
        self._stream = io.BytesIO(
            payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        )

    def read(self, size=-1):
        return self._stream.read(size)

    def close(self):
        self._stream.close()


class RecordingOpener:
    def __init__(self):
        self.requests = []

    def __call__(self, request, timeout):
        body = json.loads(request.data.decode("utf-8")) if request.data else None
        self.requests.append(
            {
                "url": request.full_url,
                "method": request.get_method(),
                "authorization": request.get_header("Authorization"),
                "body": body,
                "timeout": timeout,
            }
        )
        return FakeResponse({"request": len(self.requests)})


class QuietAgent:
    def should_use_multiagent(self, _value: str) -> bool:
        return False

    def chat_stream(self, value: str):
        yield {"type": "answer_delta", "data": {"content": f"ran: {value}"}}
        yield {"type": "done", "data": {}}


def _wait(runtime: SessionRuntime, operation_id: str):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        operation = runtime.get_operation(operation_id)
        if operation["status"] in {"succeeded", "failed"}:
            return operation
        time.sleep(0.01)
    raise AssertionError("operation did not finish")


def test_local_profile_supports_complete_trigger_lifecycle(tmp_path):
    clock = MutableClock(datetime(2026, 7, 16, 10, 0).timestamp())
    schedules = ScheduledPromptManager(tmp_path / "schedules.json", clock=clock)
    manager = TriggerManager([TriggerProfile(name="local", kind="local")])

    created = manager.execute(
        "create",
        session_id="session-1",
        body={
            "name": "Release review",
            "cron_expression": "1 10 16 7 *",
            "prompt": "review the release",
            "recurring": True,
            "durable": True,
            "enabled": False,
        },
        local_manager=schedules,
    )
    trigger_id = created["data"]["id"]
    assert created["data"]["name"] == "Release review"
    assert created["data"]["enabled"] is False

    listed = manager.execute(
        "list",
        session_id="session-1",
        local_manager=schedules,
    )
    assert listed["data"]["count"] == 1
    fetched = manager.execute(
        "get",
        session_id="session-1",
        trigger_id=trigger_id,
        local_manager=schedules,
    )
    assert fetched["data"]["prompt"] == "review the release"

    updated = manager.execute(
        "update",
        session_id="session-1",
        trigger_id=trigger_id,
        body={
            "name": "Release evidence",
            "cron_expression": "2 10 16 7 *",
            "prompt": "collect release evidence",
            "enabled": True,
        },
        local_manager=schedules,
    )
    assert updated["data"]["name"] == "Release evidence"
    assert updated["data"]["enabled"] is True
    assert updated["data"]["next_fire_at"] > clock.value

    run = manager.execute(
        "run",
        session_id="session-1",
        trigger_id=trigger_id,
        local_manager=schedules,
    )
    assert run["data"]["prompt"] == "collect release evidence"
    assert schedules.get("session-1", trigger_id)["id"] == trigger_id


def test_disabled_local_trigger_does_not_dispatch(tmp_path):
    clock = MutableClock(datetime(2026, 7, 16, 10, 0).timestamp())
    schedules = ScheduledPromptManager(tmp_path / "schedules.json", clock=clock)
    created = schedules.create(
        "session-1",
        "1 10 16 7 *",
        "should stay idle",
        enabled=False,
    )
    fired = []
    schedules._on_fire = lambda job: fired.append(job) is None or True
    clock.value = created["next_fire_at"] + 1
    schedules._tick()
    assert fired == []


def test_http_profile_uses_fixed_routes_and_in_process_authentication():
    opener = RecordingOpener()
    token = "top-secret-trigger-token"
    profile = TriggerProfile(
        name="staging",
        base_url="https://triggers.example.test/v1/agents",
        auth=EnvironmentTokenProvider("TRIGGER_TOKEN", environ={"TRIGGER_TOKEN": token}),
        headers={"X-Workspace": "engineering"},
        timeout=7,
    )
    manager = TriggerManager(
        [TriggerProfile(name="local", kind="local"), profile],
        opener=opener,
    )

    manager.execute("list", profile_name="staging", session_id="s")
    manager.execute("get", profile_name="staging", session_id="s", trigger_id="job-1")
    manager.execute(
        "create",
        profile_name="staging",
        session_id="s",
        body={"name": "nightly"},
    )
    manager.execute(
        "update",
        profile_name="staging",
        session_id="s",
        trigger_id="job-1",
        body={"enabled": False},
    )
    manager.execute("run", profile_name="staging", session_id="s", trigger_id="job-1")

    assert [(item["method"], item["url"]) for item in opener.requests] == [
        ("GET", "https://triggers.example.test/v1/agents"),
        ("GET", "https://triggers.example.test/v1/agents/job-1"),
        ("POST", "https://triggers.example.test/v1/agents"),
        ("POST", "https://triggers.example.test/v1/agents/job-1"),
        ("POST", "https://triggers.example.test/v1/agents/job-1/run"),
    ]
    assert all(item["authorization"] == f"Bearer {token}" for item in opener.requests)
    assert opener.requests[2]["body"] == {"name": "nightly"}
    assert opener.requests[4]["body"] == {}
    public = manager.profiles()
    assert token not in json.dumps(public)
    assert token not in repr(profile)
    assert public[1]["auth"]["environment_variable"] == "TRIGGER_TOKEN"


def test_http_profile_rejects_unsafe_urls_and_redacts_network_failures():
    auth = EnvironmentTokenProvider("TOKEN", environ={"TOKEN": "never-print-me"})
    with pytest.raises(ValueError, match="HTTPS"):
        TriggerProfile(name="remote", base_url="http://example.test/triggers", auth=auth)
    with pytest.raises(ValueError, match="credentials"):
        TriggerProfile(
            name="remote",
            base_url="https://user:pass@example.test/triggers",
            auth=auth,
        )

    def failing_opener(_request, timeout):
        del timeout
        raise URLError("never-print-me")

    manager = TriggerManager(
        [
            TriggerProfile(name="local", kind="local"),
            TriggerProfile(
                name="remote",
                base_url="https://example.test/triggers",
                auth=auth,
            ),
        ],
        opener=failing_opener,
    )
    with pytest.raises(TriggerRuntimeError) as captured:
        manager.execute("list", profile_name="remote", session_id="s")
    assert captured.value.code == "NETWORK_ERROR"
    assert "never-print-me" not in captured.value.message


def test_trigger_bounds_and_environment_configuration():
    configured = profiles_from_environment(
        {
            "ARFORGE_TRIGGER_PROFILES": json.dumps(
                {
                    "profiles": [{
                        "name": "prod",
                        "base_url": "https://triggers.example.test/v1/jobs",
                        "auth": {
                            "type": "bearer_environment",
                            "environment_variable": "PROD_TRIGGER_TOKEN",
                        },
                    }]
                }
            )
        }
    )
    assert [item.name for item in configured] == ["local", "prod"]
    assert configured[1].public()["auth"]["configured"] is False

    manager = TriggerManager(configured, opener=RecordingOpener())
    with pytest.raises(TriggerRuntimeError, match="size limit"):
        manager.execute(
            "create",
            profile_name="local",
            session_id="s",
            body={"prompt": "x" * (MAX_TRIGGER_BODY_BYTES + 1), "cron_expression": "* * * * *"},
        )
    with pytest.raises(TriggerRuntimeError, match="trigger_id"):
        manager.execute("get", profile_name="local", session_id="s", trigger_id="../escape")


def test_bridge_exposes_local_trigger_lifecycle_and_runs_prompt(tmp_path):
    schedules = ScheduledPromptManager(tmp_path / "schedules.json")
    triggers = TriggerManager([TriggerProfile(name="local", kind="local")])
    events = []
    runtime = SessionRuntime(
        events.append,
        agent_factory=QuietAgent,
        scheduler=schedules,
        trigger_manager=triggers,
    )
    session = runtime.create_session()
    created = dispatch(
        {
            "version": "1.2",
            "method": "trigger.create",
            "params": {
                "session_id": session["session_id"],
                "profile": "local",
                "body": {
                    "name": "Immediate review",
                    "cron_expression": "* * * * *",
                    "prompt": "review now",
                    "enabled": True,
                },
            },
        },
        runtime=runtime,
    )
    assert created["ok"] is True
    trigger_id = created["data"]["data"]["id"]

    profiles = dispatch(
        {
            "version": "1.2",
            "method": "trigger.profiles",
            "params": {"session_id": session["session_id"]},
        },
        runtime=runtime,
    )
    assert profiles["data"]["items"][0]["name"] == "local"
    updated = dispatch(
        {
            "version": "1.2",
            "method": "trigger.update",
            "params": {
                "session_id": session["session_id"],
                "trigger_id": trigger_id,
                "body": {"prompt": "review the current release"},
            },
        },
        runtime=runtime,
    )
    assert updated["data"]["data"]["prompt"] == "review the current release"
    run = dispatch(
        {
            "version": "1.2",
            "method": "trigger.run",
            "params": {
                "session_id": session["session_id"],
                "trigger_id": trigger_id,
            },
        },
        runtime=runtime,
    )
    assert run["ok"] is True
    assert _wait(runtime, run["data"]["operation"]["operation_id"])["status"] == "succeeded"
    completed = next(item for item in events if item["type"] == "operation.completed")
    assert completed["data"]["answer"] == "ran: review the current release"

    described = dispatch({"version": "1.2", "method": "protocol.describe"})
    assert "trigger.run" in described["data"]["methods"]
    assert "trigger.create" in described["data"]["mutating_methods"]
