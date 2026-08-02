"""Contract coverage for safe background command execution."""

from __future__ import annotations

import time

import pytest


def _wait(runtime, task_id: str, statuses: set[str]) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        record = runtime.get(task_id)
        if record["status"] in statuses:
            return record
        time.sleep(0.02)
    raise AssertionError(f"background task did not reach {statuses}")


def test_background_command_collects_bounded_output(tmp_path):
    from arforge.background_command_runtime import BackgroundCommandRuntime

    runtime = BackgroundCommandRuntime()
    record = runtime.start(
        'python -c "print(\'background-ok\')"',
        workspace=tmp_path,
        timeout_seconds=5,
    )
    completed = _wait(runtime, record["task_id"], {"completed"})
    snapshot = runtime.output(record["task_id"], max_chars=200)

    assert completed["exit_code"] == 0
    assert "background-ok" in snapshot["output"]
    assert "command" not in snapshot


def test_background_command_rejects_shell_metacharacters_and_pipelines(tmp_path):
    from arforge.background_command_runtime import BackgroundCommandError, BackgroundCommandRuntime

    runtime = BackgroundCommandRuntime()
    with pytest.raises(BackgroundCommandError, match="shell metacharacters"):
        runtime.start("python -c 'print(1)' && dir", workspace=tmp_path)
    with pytest.raises(BackgroundCommandError, match="pipelines"):
        runtime.start("python -c 'print(1)' | sort", workspace=tmp_path)


def test_background_command_can_be_cancelled(tmp_path):
    from arforge.background_command_runtime import BackgroundCommandRuntime

    runtime = BackgroundCommandRuntime()
    (tmp_path / "sleeper.py").write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
    record = runtime.start(
        "python sleeper.py",
        workspace=tmp_path,
        timeout_seconds=60,
    )
    cancelled = runtime.cancel(record["task_id"])
    final = _wait(runtime, record["task_id"], {"cancelled"})

    assert cancelled["status"] == "cancellation_requested"
    assert final["stop_reason"] == "client_request"


def test_background_command_timeout_and_sandbox_cover_the_new_tool(tmp_path):
    from arforge.background_command_runtime import BackgroundCommandRuntime
    from arforge.security.sandbox_enforce import SandboxDecision, enforce

    runtime = BackgroundCommandRuntime()
    (tmp_path / "timeout.py").write_text("import time\ntime.sleep(5)\n", encoding="utf-8")
    record = runtime.start(
        "python timeout.py",
        workspace=tmp_path,
        timeout_seconds=1,
    )
    final = _wait(runtime, record["task_id"], {"timed_out"})
    decision, _reason = enforce("run_background_cmd", {"command": "curl example.com"}, sandbox_mode="read-only")

    assert final["stop_reason"] == "timeout"
    assert decision == SandboxDecision.BLOCKED_NETWORK


def test_background_command_tool_defaults_to_no_timeout():
    import arforge.tools.basic_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("run_background_cmd")
    assert tool is not None
    timeout_param = next(
        param for param in tool.schema.params if param.name == "timeout_seconds"
    )
    assert timeout_param.default == 0


def test_run_cmd_defaults_to_no_timeout(monkeypatch, tmp_path):
    import arforge.tools.basic_tools as basic_tools
    from arforge.tool_registry import REGISTRY

    observed: dict[str, object] = {}

    def fake_run(command, *, cwd, timeout):
        observed.update(command=command, cwd=cwd, timeout=timeout)
        return {"success": True, "stdout": "ok", "stderr": "", "returncode": 0}

    monkeypatch.setattr(basic_tools, "run_command_no_shell", fake_run)
    monkeypatch.setattr("arforge.tools.file_tools.get_workspace", lambda: tmp_path)

    assert basic_tools.run_cmd("npm ci") == "ok"
    assert observed == {"command": "npm ci", "cwd": tmp_path, "timeout": None}

    tool = REGISTRY.get("run_cmd")
    assert tool is not None
    timeout_param = next(
        param for param in tool.schema.params if param.name == "timeout_seconds"
    )
    assert timeout_param.default == 0
    assert tool.schema.timeout == 0
