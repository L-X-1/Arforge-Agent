"""Revisioned, validated desktop keybinding configuration."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


UTC = timezone.utc
SCHEMA_VERSION = 1
ACTION_DETAILS = {
    "session:new": {"label": "新建会话", "default": "ctrl+n"},
    "history:search": {"label": "搜索会话", "default": "ctrl+shift+f"},
    "settings:open": {"label": "打开设置", "default": "ctrl+,"},
}
DEFAULT_BINDINGS = {action: detail["default"] for action, detail in ACTION_DETAILS.items()}
_MODIFIERS = {"ctrl", "meta", "shift"}
_KEY_PATTERN = re.compile(r"^[a-z0-9,./]$")
_RESERVED = {
    "ctrl+w", "ctrl+r", "ctrl+l", "ctrl+t", "ctrl+q",
    "meta+w", "meta+r", "meta+l", "meta+t", "meta+q",
}


class KeybindingRuntimeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class KeybindingRuntime:
    """Own desktop shortcut validation, optimistic locking, and persistence."""

    def __init__(self, path: Path):
        self.path = Path(path).resolve()
        self._lock = threading.RLock()

    def get(self) -> dict[str, Any]:
        with self._lock:
            return self._public(self._load())

    @contextmanager
    def _exclusive_update_lock(self):
        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + 2.0
        descriptor: int | None = None
        while descriptor is None:
            try:
                descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.write(descriptor, str(os.getpid()).encode("ascii"))
            except FileExistsError:
                try:
                    if time.time() - lock_path.stat().st_mtime > 30:
                        lock_path.unlink(missing_ok=True)
                        continue
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    raise KeybindingRuntimeError("KEYBINDINGS_BUSY", "another process is updating keybindings") from None
                time.sleep(0.02)
        try:
            yield
        finally:
            os.close(descriptor)
            lock_path.unlink(missing_ok=True)

    def update(self, bindings: dict[str, Any], expected_revision: int) -> dict[str, Any]:
        validated = self._validate_bindings(bindings)
        if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 0:
            raise KeybindingRuntimeError("INVALID_PARAMS", "expected_revision must be a non-negative integer")
        with self._lock, self._exclusive_update_lock():
            document = self._load()
            if document["revision"] != expected_revision:
                raise KeybindingRuntimeError("REVISION_CONFLICT", "keybindings changed; fetch the latest revision")
            document["bindings"] = validated
            document["revision"] += 1
            document["updated_at"] = _utc_now()
            self._atomic_write(self.path, document)
            return self._public(document)

    def reset(self, expected_revision: int) -> dict[str, Any]:
        return self.update(dict(DEFAULT_BINDINGS), expected_revision)

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {
                "schema_version": SCHEMA_VERSION,
                "revision": 0,
                "updated_at": None,
                "bindings": dict(DEFAULT_BINDINGS),
            }
        if not self.path.is_file() or self.path.stat().st_size > 32 * 1024:
            raise KeybindingRuntimeError("KEYBINDINGS_CORRUPT", "keybindings file is invalid")
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise KeybindingRuntimeError("KEYBINDINGS_CORRUPT", "keybindings file is unreadable") from None
        if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
            raise KeybindingRuntimeError("KEYBINDINGS_CORRUPT", "keybindings schema is unsupported")
        revision = value.get("revision")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
            raise KeybindingRuntimeError("KEYBINDINGS_CORRUPT", "keybindings revision is invalid")
        try:
            bindings = self._validate_bindings(value.get("bindings"))
        except KeybindingRuntimeError:
            raise KeybindingRuntimeError("KEYBINDINGS_CORRUPT", "stored keybindings are invalid") from None
        return {
            "schema_version": SCHEMA_VERSION,
            "revision": revision,
            "updated_at": value.get("updated_at"),
            "bindings": bindings,
        }

    @staticmethod
    def _validate_bindings(bindings: Any) -> dict[str, str | None]:
        if not isinstance(bindings, dict) or set(bindings) != set(ACTION_DETAILS):
            raise KeybindingRuntimeError("INVALID_PARAMS", "bindings must contain exactly the supported actions")
        result: dict[str, str | None] = {}
        seen: set[str] = set()
        for action, value in bindings.items():
            if value is None:
                result[action] = None
                continue
            if not isinstance(value, str):
                raise KeybindingRuntimeError("INVALID_KEYBINDING", f"binding for {action} must be a string or null")
            chord = KeybindingRuntime._validate_chord(value)
            if chord in seen:
                raise KeybindingRuntimeError("KEYBINDING_CONFLICT", "each enabled keybinding must be unique")
            seen.add(chord)
            result[action] = chord
        return result

    @staticmethod
    def _validate_chord(value: str) -> str:
        chord = value.strip().lower()
        if chord != value.lower() or len(chord) > 32 or not chord:
            raise KeybindingRuntimeError("INVALID_KEYBINDING", "keybinding format is invalid")
        parts = chord.split("+")
        if len(parts) < 2 or any(not part for part in parts):
            raise KeybindingRuntimeError("INVALID_KEYBINDING", "keybinding requires a modifier and one key")
        modifiers = parts[:-1]
        key = parts[-1]
        if any(modifier not in _MODIFIERS for modifier in modifiers) or len(set(modifiers)) != len(modifiers):
            raise KeybindingRuntimeError("INVALID_KEYBINDING", "keybinding modifiers are invalid")
        if not {"ctrl", "meta"}.intersection(modifiers) or not _KEY_PATTERN.fullmatch(key):
            raise KeybindingRuntimeError("INVALID_KEYBINDING", "keybinding must use ctrl or meta plus a supported key")
        canonical = "+".join([*(item for item in ("ctrl", "meta", "shift") if item in modifiers), key])
        if canonical in _RESERVED:
            raise KeybindingRuntimeError("RESERVED_KEYBINDING", "keybinding is reserved by the desktop environment")
        return canonical

    @staticmethod
    def _public(document: dict[str, Any]) -> dict[str, Any]:
        return {
            "schema_version": document["schema_version"],
            "revision": document["revision"],
            "updated_at": document["updated_at"],
            "bindings": dict(document["bindings"]),
            "actions": {action: {"label": detail["label"], "default": detail["default"]} for action, detail in ACTION_DETAILS.items()},
        }

    @staticmethod
    def _atomic_write(path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump(value, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            try:
                temporary.chmod(0o600)
            except OSError:
                pass
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
