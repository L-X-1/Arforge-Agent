"""Safe, in-memory background command execution for the agent tool surface."""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from arforge.security_guard import sanitize_log_message


ACTIVE_STATUSES = {"running", "cancellation_requested"}
TERMINAL_STATUSES = {"completed", "failed", "cancelled", "timed_out"}
_MAX_CONCURRENT = 4
_MAX_CAPTURED_CHARS = 64_000


class BackgroundCommandError(ValueError):
    """Raised when a background command operation is invalid or unsafe."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class BackgroundCommand:
    """Metadata for one process owned by this runtime instance."""

    task_id: str
    status: str
    created_at: str
    updated_at: str
    timeout_seconds: int
    started_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None
    output: str = ""
    output_truncated: bool = False
    stop_reason: str | None = None
    cancel_requested: threading.Event = field(default_factory=threading.Event, repr=False)
    process: subprocess.Popen[str] | None = field(default=None, repr=False)
    worker: threading.Thread | None = field(default=None, repr=False)

    def public(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "exit_code": self.exit_code,
            "timeout_seconds": self.timeout_seconds,
            "output_truncated": self.output_truncated,
            "stop_reason": self.stop_reason,
        }


class BackgroundCommandRuntime:
    """Own and supervise cancellable no-shell processes for the current process."""

    def __init__(self, *, max_concurrent: int = _MAX_CONCURRENT):
        self._max_concurrent = max_concurrent
        self._commands: dict[str, BackgroundCommand] = {}
        self._lock = threading.RLock()

    def start(self, command: str, *, workspace: str | Path, timeout_seconds: int = 0) -> dict[str, Any]:
        """Validate and launch a single safe command without involving a shell."""
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) or timeout_seconds < 0:
            raise BackgroundCommandError("timeout_seconds must be a non-negative integer; 0 disables the timeout")
        args = self._validated_args(command)
        workspace_path = Path(workspace).resolve()
        if not workspace_path.is_dir():
            raise BackgroundCommandError("workspace directory does not exist")
        with self._lock:
            if sum(item.status in ACTIVE_STATUSES for item in self._commands.values()) >= self._max_concurrent:
                raise BackgroundCommandError("background command limit reached")
            now = _now()
            record = BackgroundCommand(
                task_id=str(uuid.uuid4()),
                status="running",
                created_at=now,
                updated_at=now,
                started_at=now,
                timeout_seconds=timeout_seconds,
            )
            try:
                creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
                record.process = subprocess.Popen(
                    args,
                    cwd=workspace_path,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    shell=False,
                    creationflags=creationflags,
                    start_new_session=os.name != "nt",
                )
            except FileNotFoundError as exc:
                raise BackgroundCommandError(f"command not found: {args[0]}") from exc
            self._commands[record.task_id] = record
            record.worker = threading.Thread(
                target=self._collect,
                args=(record,),
                name=f"arforge-background-{record.task_id[:8]}",
                daemon=True,
            )
            record.worker.start()
            return record.public()

    def get(self, task_id: str) -> dict[str, Any]:
        with self._lock:
            return self._require(task_id).public()

    def list(self, *, limit: int = 50) -> dict[str, Any]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
            raise BackgroundCommandError("limit must be an integer between 1 and 200")
        with self._lock:
            items = sorted(self._commands.values(), key=lambda item: item.created_at, reverse=True)
            return {"items": [item.public() for item in items[:limit]], "count": min(len(items), limit), "total": len(items)}

    def output(self, task_id: str, *, max_chars: int = 8000) -> dict[str, Any]:
        if isinstance(max_chars, bool) or not isinstance(max_chars, int) or not 200 <= max_chars <= 16_000:
            raise BackgroundCommandError("max_chars must be an integer between 200 and 16000")
        with self._lock:
            record = self._require(task_id)
            text = sanitize_log_message(record.output[-max_chars:])
            return record.public() | {"output": text, "output_available": bool(record.output)}

    def cancel(self, task_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require(task_id)
            if record.status in TERMINAL_STATUSES:
                return record.public()
            record.cancel_requested.set()
            record.status = "cancellation_requested"
            record.stop_reason = "client_request"
            record.updated_at = _now()
            self._terminate(record)
            return record.public()

    def shutdown(self) -> None:
        """Request termination for every process owned by this runtime."""
        with self._lock:
            for record in self._commands.values():
                if record.status in ACTIVE_STATUSES:
                    record.cancel_requested.set()
                    record.stop_reason = "runtime_shutdown"
                    self._terminate(record)

    @staticmethod
    def _validated_args(command: str) -> list[str]:
        from arforge.tools.basic_tools import _split_command_args, _split_pipeline, _validate_segment

        text = str(command).strip()
        segments = _split_pipeline(text)
        if len(segments) != 1:
            raise BackgroundCommandError("background commands do not support pipelines")
        if not segments:
            raise BackgroundCommandError("empty command")
        allowed, reason = _validate_segment(segments[0])
        if not allowed:
            raise BackgroundCommandError(reason)
        args = _split_command_args(segments[0])
        if not args:
            raise BackgroundCommandError("empty command")
        if args[0].casefold() == "echo":
            raise BackgroundCommandError("shell builtin echo is not supported as a background command")
        return args

    def _collect(self, record: BackgroundCommand) -> None:
        process = record.process
        if process is None or process.stdout is None:
            return
        reader = threading.Thread(target=self._read_output, args=(record, process.stdout), daemon=True)
        reader.start()
        deadline = (
            time.monotonic() + record.timeout_seconds
            if record.timeout_seconds > 0
            else None
        )
        while process.poll() is None:
            if record.cancel_requested.is_set():
                self._terminate(record)
            elif deadline is not None and time.monotonic() >= deadline:
                with self._lock:
                    record.stop_reason = "timeout"
                self._terminate(record)
            time.sleep(0.05)
        reader.join(timeout=1.0)
        with self._lock:
            record.exit_code = process.returncode
            record.finished_at = _now()
            record.updated_at = record.finished_at
            if record.cancel_requested.is_set():
                record.status = "cancelled"
            elif record.stop_reason == "timeout":
                record.status = "timed_out"
            elif process.returncode == 0:
                record.status = "completed"
            else:
                record.status = "failed"

    def _read_output(self, record: BackgroundCommand, stream) -> None:
        try:
            while True:
                chunk = stream.read(1024)
                if not chunk:
                    break
                with self._lock:
                    combined = record.output + chunk
                    if len(combined) > _MAX_CAPTURED_CHARS:
                        record.output = combined[-_MAX_CAPTURED_CHARS:]
                        record.output_truncated = True
                    else:
                        record.output = combined
        finally:
            stream.close()

    @staticmethod
    def _terminate(record: BackgroundCommand) -> None:
        process = record.process
        if process is None or process.poll() is not None:
            return
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    check=False,
                    capture_output=True,
                    timeout=5,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                os.killpg(process.pid, signal.SIGTERM)
        except (OSError, subprocess.SubprocessError):
            try:
                process.terminate()
            except OSError:
                pass

    def _require(self, task_id: str) -> BackgroundCommand:
        if not isinstance(task_id, str) or not task_id:
            raise BackgroundCommandError("task_id must be a non-empty string")
        record = self._commands.get(task_id)
        if record is None:
            raise BackgroundCommandError("background command not found")
        return record


_runtime: BackgroundCommandRuntime | None = None
_runtime_lock = threading.Lock()


def get_background_command_runtime() -> BackgroundCommandRuntime:
    """Return the process-local runtime shared by the background command tools."""
    global _runtime
    with _runtime_lock:
        if _runtime is None:
            _runtime = BackgroundCommandRuntime()
        return _runtime


def reset_background_command_runtime() -> None:
    """Stop and discard the process-local runtime; intended for controlled tests."""
    global _runtime
    with _runtime_lock:
        if _runtime is not None:
            _runtime.shutdown()
        _runtime = None
