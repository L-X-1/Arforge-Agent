"""Lightweight logging helpers for Arforge Agent."""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from arforge.paths import data_path


def _log_file():
    return data_path("logs", "arforge.log")


_WRITE_LOCK = threading.Lock()


def write_log(
    level: str,
    message: Any,
    *,
    context: dict[str, Any] | None = None,
    event_id: str | None = None,
) -> None:
    """Append a sanitised log entry to the local Arforge log file.

    API keys, tokens, and secrets are automatically redacted.
    Logging must never break the agent runtime, so filesystem errors are
    intentionally swallowed.
    """

    from arforge.security_guard import sanitize_log_message, sanitize_sensitive_data

    safe_message = sanitize_log_message(str(message))
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "level": str(level).upper(),
        "event_id": event_id or str(uuid4()),
        "pid": os.getpid(),
        "message": safe_message,
    }
    if context:
        record["context"] = sanitize_sensitive_data(context)

    try:
        log_file = _log_file()
        log_file.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        with _WRITE_LOCK, log_file.open("a", encoding="utf-8") as stream:
            stream.write(line)
        try:
            log_file.chmod(0o600)
        except OSError:
            pass
    except Exception:
        return


def log_info(message: Any) -> None:
    write_log("info", message)


def log_warning(message: Any) -> None:
    write_log("warning", message)


def log_error(message: Any) -> None:
    write_log("error", message)
