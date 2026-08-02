"""Private worker process for the local background MCP service."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from arforge.mcp_runtime import create_arforge_mcp_transport

_POLL_SECONDS = 0.2
_READY_TIMEOUT_SECONDS = 5.0


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_status(path: Path, **values: Any) -> None:
    path.write_text(json.dumps(values, ensure_ascii=False, sort_keys=True), encoding="utf-8")


def run_worker(
    config_path: Path,
    *,
    transport_factory: Callable[..., Any] = create_arforge_mcp_transport,
) -> int:
    """Run the service until a correctly authenticated stop request arrives."""
    config = _read_json(config_path)
    host = config.get("host")
    port = config.get("port")
    control_token = config.get("control_token")
    if not isinstance(host, str) or not isinstance(port, int) or not isinstance(control_token, str):
        raise ValueError("daemon configuration is invalid")

    root = config_path.parent
    status_path = root / "status.json"
    stop_path = root / "stop.json"
    transport = transport_factory(host=host, port=port)
    failure: list[BaseException] = []

    def serve() -> None:
        try:
            transport.run()
        except BaseException as exc:  # Report startup errors to the parent process.
            failure.append(exc)

    thread = threading.Thread(target=serve, name="arforge-daemon-http", daemon=True)
    thread.start()
    if not transport.wait_until_ready(_READY_TIMEOUT_SECONDS):
        error = str(failure[0]) if failure else "listener did not become ready"
        _write_status(status_path, running=False, pid=os.getpid(), error=error)
        return 1

    _write_status(status_path, running=True, pid=os.getpid(), host=host, port=port)
    try:
        while thread.is_alive():
            request = _read_json(stop_path)
            if request.get("control_token") == control_token:
                transport.stop()
                thread.join(timeout=_READY_TIMEOUT_SECONDS)
                break
            time.sleep(_POLL_SECONDS)
    finally:
        _write_status(status_path, running=False, pid=os.getpid())
    return 0


def main(argv: list[str] | None = None) -> int:
    arguments = argv if argv is not None else sys.argv[1:]
    if len(arguments) != 1:
        raise ValueError("daemon worker requires exactly one configuration path")
    return run_worker(Path(arguments[0]).resolve())


if __name__ == "__main__":
    raise SystemExit(main())
