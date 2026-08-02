"""Cooperative lifecycle management for the local background MCP service.

The daemon is intentionally local-only.  It is controlled through a random
per-start token written beneath the user's application data directory instead
of sending signals to arbitrary process identifiers.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from arforge.paths import data_path

_STARTUP_TIMEOUT_SECONDS = 5.0


def daemon_paths() -> tuple[Path, Path, Path, Path, Path]:
    """Return the private files used to coordinate the local service."""
    root = Path(data_path("daemon"))
    return (
        root,
        root / "config.json",
        root / "status.json",
        root / "stop.json",
        root / "service.log",
    )


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True), encoding="utf-8")


def daemon_status() -> dict[str, Any]:
    """Return the last worker status without exposing its control token."""
    _, _, status_path, _, _ = daemon_paths()
    status = _read_json(status_path)
    return status if status else {"running": False}


def _worker_command(config_path: Path) -> list[str]:
    return [sys.executable, "-m", "arforge.daemon_worker", str(config_path)]


def start_daemon(*, host: str = "127.0.0.1", port: int = 8800) -> dict[str, Any]:
    """Start a local worker and wait until its HTTP listener is ready."""
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError("daemon only supports loopback hosts")
    if not 1 <= port <= 65535:
        raise ValueError("daemon port must be between 1 and 65535")

    root, config_path, status_path, stop_path, log_path = daemon_paths()
    root.mkdir(parents=True, exist_ok=True)
    if daemon_status().get("running"):
        raise RuntimeError("daemon is already running")

    control_token = secrets.token_urlsafe(32)
    stop_path.unlink(missing_ok=True)
    status_path.unlink(missing_ok=True)
    _write_json(
        config_path,
        {"host": host, "port": port, "control_token": control_token},
    )

    popen_kwargs: dict[str, Any] = {
        "stdout": None,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "shell": False,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    with log_path.open("ab") as log_stream:
        popen_kwargs["stdout"] = log_stream
        process = subprocess.Popen(_worker_command(config_path), **popen_kwargs)

    deadline = time.monotonic() + _STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        status = daemon_status()
        if status.get("running") or status.get("error"):
            return status
        if process.poll() is not None:
            break
        time.sleep(0.05)

    return {
        "running": False,
        "pid": process.pid,
        "error": "worker did not report a ready listener; inspect the daemon log",
    }


def stop_daemon() -> dict[str, Any]:
    """Request a cooperative shutdown from the current local worker."""
    _, config_path, _, stop_path, _ = daemon_paths()
    config = _read_json(config_path)
    control_token = config.get("control_token")
    if not isinstance(control_token, str) or not control_token:
        return {"requested": False, "reason": "daemon configuration not found"}

    _write_json(stop_path, {"control_token": control_token})
    return {"requested": True}
