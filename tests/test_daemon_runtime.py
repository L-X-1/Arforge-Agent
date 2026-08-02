"""Tests for cooperative local background service management."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path


def _paths(root: Path):
    return (
        root,
        root / "config.json",
        root / "status.json",
        root / "stop.json",
        root / "service.log",
    )


def test_start_daemon_uses_module_worker_without_shell(monkeypatch, tmp_path):
    import arforge.daemon_runtime as runtime

    monkeypatch.setattr(runtime, "daemon_paths", lambda: _paths(tmp_path))
    statuses = iter(({"running": False}, {"running": True, "pid": 42}))
    monkeypatch.setattr(runtime, "daemon_status", lambda: next(statuses))
    captured = {}

    class FakeProcess:
        pid = 42

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr(runtime.subprocess, "Popen", fake_popen)
    result = runtime.start_daemon(port=9123)

    assert result == {"running": True, "pid": 42}
    assert captured["command"][1:3] == ["-m", "arforge.daemon_worker"]
    assert captured["kwargs"]["shell"] is False
    config = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert config["port"] == 9123
    assert config["control_token"]


def test_stop_daemon_writes_matching_control_token(monkeypatch, tmp_path):
    import arforge.daemon_runtime as runtime

    monkeypatch.setattr(runtime, "daemon_paths", lambda: _paths(tmp_path))
    tmp_path.mkdir(exist_ok=True)
    (tmp_path / "config.json").write_text(
        json.dumps({"control_token": "local-control-token"}), encoding="utf-8"
    )

    assert runtime.stop_daemon() == {"requested": True}
    request = json.loads((tmp_path / "stop.json").read_text(encoding="utf-8"))
    assert request == {"control_token": "local-control-token"}


def test_worker_ignores_invalid_stop_request_before_accepting_valid_request(tmp_path):
    from arforge.daemon_worker import run_worker

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"host": "127.0.0.1", "port": 9123, "control_token": "expected"}),
        encoding="utf-8",
    )
    started = threading.Event()

    class FakeTransport:
        def __init__(self):
            self.ready = threading.Event()
            self.stopped = threading.Event()

        def run(self):
            self.ready.set()
            started.set()
            self.stopped.wait(timeout=2)

        def wait_until_ready(self, timeout):
            return self.ready.wait(timeout)

        def stop(self):
            self.stopped.set()

    transport = FakeTransport()
    writer = threading.Thread(
        target=lambda: _write_stop_requests(tmp_path, started), daemon=True
    )
    writer.start()

    assert run_worker(config, transport_factory=lambda **_kwargs: transport) == 0
    assert transport.stopped.is_set()
    status = json.loads((tmp_path / "status.json").read_text(encoding="utf-8"))
    assert status["running"] is False


def _write_stop_requests(root: Path, started: threading.Event) -> None:
    assert started.wait(timeout=1)
    stop_path = root / "stop.json"
    stop_path.write_text(json.dumps({"control_token": "wrong"}), encoding="utf-8")
    time.sleep(0.25)
    stop_path.write_text(json.dumps({"control_token": "expected"}), encoding="utf-8")


def test_worker_reports_listener_startup_failure(tmp_path):
    from arforge.daemon_worker import run_worker

    config = tmp_path / "config.json"
    config.write_text(
        json.dumps({"host": "127.0.0.1", "port": 9123, "control_token": "expected"}),
        encoding="utf-8",
    )

    class FailingTransport:
        def run(self):
            raise OSError("address already in use")

        def wait_until_ready(self, _timeout):
            return False

    assert run_worker(config, transport_factory=lambda **_kwargs: FailingTransport()) == 1
    status = json.loads((tmp_path / "status.json").read_text(encoding="utf-8"))
    assert status["running"] is False
    assert "address already in use" in status["error"]
