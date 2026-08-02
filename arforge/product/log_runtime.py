"""Bounded, redacted log queries for Machine Bridge clients."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

from arforge.security_guard import sanitize_log_message, sanitize_sensitive_data


MAX_LIMIT = 200
MAX_SCAN_BYTES = 4 * 1024 * 1024
MAX_LINE_BYTES = 64 * 1024
MAX_MESSAGE_CHARS = 2_048
MAX_CONTEXT_BYTES = 2_048
ALLOWED_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}


class LogRuntimeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class LogRuntime:
    """Read the canonical JSONL log without exposing filesystem controls."""

    def __init__(self, log_file: Path):
        self._log_file = Path(log_file).resolve()

    def query(
        self,
        *,
        limit: int = 50,
        cursor: str | None = None,
        levels: list[str] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIMIT:
            raise LogRuntimeError("INVALID_PARAMS", f"limit must be an integer between 1 and {MAX_LIMIT}")
        normalized_levels = self._validate_levels(levels)
        if not self._log_file.exists():
            if cursor is not None:
                raise LogRuntimeError("CURSOR_EXPIRED", "log file is no longer available")
            return {"items": [], "count": 0, "next_cursor": None, "has_more": False, "scanned": 0, "skipped": 0}
        if not self._log_file.is_file():
            raise LogRuntimeError("LOG_UNAVAILABLE", "log target is not a regular file")

        size = self._log_file.stat().st_size
        end = size if cursor is None else self._decode_cursor(cursor)
        if end > size:
            raise LogRuntimeError("CURSOR_EXPIRED", "log file changed since the previous page")

        items: list[dict[str, Any]] = []
        scanned = 0
        skipped = 0
        start = max(0, end - MAX_SCAN_BYTES)
        with self._log_file.open("rb") as stream:
            stream.seek(start)
            data = stream.read(end - start)
        aligned_start = start
        if start > 0:
            newline = data.find(b"\n")
            if newline < 0:
                return {
                    "items": [],
                    "count": 0,
                    "next_cursor": self._encode_cursor(start),
                    "has_more": True,
                    "scanned": 0,
                    "skipped": 1,
                }
            aligned_start = start + newline + 1
            data = data[newline + 1 :]

        records: list[tuple[int, bytes]] = []
        offset = aligned_start
        for raw_with_ending in data.splitlines(keepends=True):
            raw = raw_with_ending.rstrip(b"\r\n")
            records.append((offset, raw))
            offset += len(raw_with_ending)

        next_offset: int | None = None
        for record_offset, raw in reversed(records):
            if not raw:
                continue
            scanned += 1
            item = self._parse_line(raw, normalized_levels)
            if item is None:
                skipped += 1
                continue
            items.append(item)
            if len(items) >= limit:
                next_offset = record_offset
                break

        if next_offset is None and aligned_start > 0:
            next_offset = aligned_start
        has_more = next_offset is not None and next_offset > 0
        next_cursor = self._encode_cursor(next_offset) if has_more else None
        return {
            "items": items,
            "count": len(items),
            "next_cursor": next_cursor,
            "has_more": has_more,
            "scanned": scanned,
            "skipped": skipped,
        }

    @staticmethod
    def _parse_line(raw: bytes, levels: set[str] | None) -> dict[str, Any] | None:
        if len(raw) > MAX_LINE_BYTES:
            return None
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
            return None
        if not isinstance(value, dict):
            return None
        level = str(value.get("level", "INFO")).upper()
        if level not in ALLOWED_LEVELS or levels is not None and level not in levels:
            return None
        try:
            pid = value.get("pid")
            result = {
                "timestamp": str(value.get("timestamp", ""))[:64],
                "level": level,
                "event_id": str(value.get("event_id", ""))[:128],
                "pid": pid if isinstance(pid, int) and not isinstance(pid, bool) else None,
                "message": sanitize_log_message(str(value.get("message", "")))[:MAX_MESSAGE_CHARS],
            }
            context = value.get("context")
            if isinstance(context, dict):
                sanitized = sanitize_sensitive_data(context)
                rendered = json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"))
                result["context"] = (
                    sanitized
                    if len(rendered.encode("utf-8")) <= MAX_CONTEXT_BYTES
                    else {"truncated": True}
                )
        except (RecursionError, TypeError, ValueError):
            return None
        return result

    @staticmethod
    def _validate_levels(levels: list[str] | None) -> set[str] | None:
        if levels is None:
            return None
        if not isinstance(levels, list) or not levels:
            raise LogRuntimeError("INVALID_PARAMS", "levels must be a non-empty array")
        normalized = {str(level).upper() for level in levels if isinstance(level, str)}
        if len(normalized) != len(levels) or not normalized <= ALLOWED_LEVELS:
            raise LogRuntimeError("INVALID_PARAMS", "levels contains an unsupported value")
        return normalized

    @staticmethod
    def _encode_cursor(offset: int) -> str:
        return base64.urlsafe_b64encode(str(offset).encode("ascii")).decode("ascii").rstrip("=")

    @staticmethod
    def _decode_cursor(cursor: str) -> int:
        if not isinstance(cursor, str) or not cursor or len(cursor) > 32:
            raise LogRuntimeError("INVALID_CURSOR", "cursor is invalid")
        try:
            padding = "=" * (-len(cursor) % 4)
            decoded = base64.urlsafe_b64decode(cursor + padding).decode("ascii")
            offset = int(decoded)
        except (ValueError, UnicodeDecodeError):
            raise LogRuntimeError("INVALID_CURSOR", "cursor is invalid") from None
        if offset < 0:
            raise LogRuntimeError("INVALID_CURSOR", "cursor is invalid")
        return offset
