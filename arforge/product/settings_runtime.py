"""Non-sensitive, revisioned settings for CLI and desktop clients."""

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


DEFAULTS = {
    "language": "zh",
    "theme": "system",
    "custom_theme": "",
    "log_retention_days": 30,
    "chat_timeout_ms": 0,
    "file_open_target": "system",
    "integrated_shell": "powershell" if os.name == "nt" else "bash",
    "terminal_position": "bottom",
    "show_bottom_panel": True,
    "branch_prefix": "arforge/",
    "pr_merge_method": "squash",
    "allow_force_push": False,
    "draft_pull_requests": False,
    "auto_delete_worktrees": True,
    "worktree_retention_limit": 15,
    "accent_color": "#58a6ff",
    "translucent_sidebar": False,
    "reasoning_effort": "medium",
}
SCHEMA = {
    "language": {"type": "enum", "options": ["zh", "en"]},
    "theme": {"type": "enum", "options": ["system", "light", "dark"]},
    "custom_theme": {"type": "string", "maximum": 64},
    "log_retention_days": {"type": "integer", "minimum": 0, "maximum": 365},
    "chat_timeout_ms": {"type": "integer", "minimum": 0, "maximum": 0},
    "file_open_target": {"type": "enum", "options": ["system", "vscode"]},
    "integrated_shell": {"type": "enum", "options": ["powershell", "cmd", "bash"]},
    "terminal_position": {"type": "enum", "options": ["bottom", "right"]},
    "show_bottom_panel": {"type": "boolean"},
    "branch_prefix": {"type": "string", "maximum": 64},
    "pr_merge_method": {"type": "enum", "options": ["merge", "squash", "rebase"]},
    "allow_force_push": {"type": "boolean"},
    "draft_pull_requests": {"type": "boolean"},
    "auto_delete_worktrees": {"type": "boolean"},
    "worktree_retention_limit": {"type": "integer", "minimum": 1, "maximum": 100},
    "accent_color": {"type": "string", "format": "hex-color"},
    "translucent_sidebar": {"type": "boolean"},
    "reasoning_effort": {"type": "enum", "options": ["low", "medium", "high", "ultra"]},
}
SENSITIVE_FRAGMENTS = {"key", "token", "secret", "password", "credential", "database", "url", "auto_approve"}


class SettingsRuntimeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class SettingsRuntime:
    """Own the allowlist, validation, optimistic lock, and atomic persistence."""

    def __init__(self, path: Path, legacy_language_file: Path | None = None):
        self.path = Path(path).resolve()
        self._legacy_language_file = Path(legacy_language_file).resolve() if legacy_language_file else None
        self._lock = threading.RLock()

    def get(self) -> dict[str, Any]:
        with self._lock:
            document = self._load()
            return self._public(document)

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
                    raise SettingsRuntimeError("SETTINGS_BUSY", "another process is updating settings") from None
                time.sleep(0.02)
        try:
            yield
        finally:
            os.close(descriptor)
            lock_path.unlink(missing_ok=True)

    def update(self, changes: dict[str, Any], expected_revision: int) -> dict[str, Any]:
        if not isinstance(changes, dict) or not changes:
            raise SettingsRuntimeError("INVALID_PARAMS", "changes must be a non-empty object")
        if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 0:
            raise SettingsRuntimeError("INVALID_PARAMS", "expected_revision must be a non-negative integer")
        unknown = sorted(set(changes) - set(DEFAULTS))
        if unknown:
            code = "SENSITIVE_SETTING" if any(
                fragment in key.lower() for key in unknown for fragment in SENSITIVE_FRAGMENTS
            ) else "SETTING_NOT_ALLOWED"
            raise SettingsRuntimeError(code, f"settings are not writable: {', '.join(unknown)}")
        validated = {key: self._validate(key, value) for key, value in changes.items()}
        with self._lock, self._exclusive_update_lock():
            document = self._load()
            if document["revision"] != expected_revision:
                raise SettingsRuntimeError("REVISION_CONFLICT", "settings changed; fetch the latest revision")
            document["settings"].update(validated)
            document["revision"] += 1
            document["updated_at"] = _utc_now()
            self._atomic_write(self.path, document)
            if "language" in validated and self._legacy_language_file is not None:
                self._atomic_write(self._legacy_language_file, {"lang": validated["language"]})
            return self._public(document)

    def value(self, key: str) -> Any:
        return self.get()["settings"][key]

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            settings = dict(DEFAULTS)
            if self._legacy_language_file and self._legacy_language_file.is_file():
                try:
                    legacy = json.loads(self._legacy_language_file.read_text(encoding="utf-8"))
                    if legacy.get("lang") in {"zh", "en"}:
                        settings["language"] = legacy["lang"]
                except (OSError, json.JSONDecodeError):
                    pass
            return {"schema_version": 1, "revision": 0, "updated_at": None, "settings": settings}
        if not self.path.is_file() or self.path.stat().st_size > 64 * 1024:
            raise SettingsRuntimeError("SETTINGS_CORRUPT", "settings file is invalid")
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise SettingsRuntimeError("SETTINGS_CORRUPT", "settings file is unreadable") from None
        if not isinstance(value, dict) or value.get("schema_version") != 1:
            raise SettingsRuntimeError("SETTINGS_CORRUPT", "settings schema is unsupported")
        revision = value.get("revision")
        stored = value.get("settings")
        if not isinstance(revision, int) or revision < 0 or not isinstance(stored, dict):
            raise SettingsRuntimeError("SETTINGS_CORRUPT", "settings structure is invalid")
        if not set(stored).issubset(DEFAULTS):
            raise SettingsRuntimeError("SETTINGS_CORRUPT", "settings fields do not match the schema")
        # Older desktop releases stored only the original four preferences.
        # Additive fields are migrated in memory and become durable on the next
        # revisioned update without rewriting files during a read operation.
        stored = {**DEFAULTS, **stored}
        # Version-1 settings could persist a 1-900 second Agent deadline.
        # The no-timeout release deliberately migrates every such value to 0
        # in memory so existing installations receive the new behavior on the
        # first launch, not only fresh profiles.
        stored = dict(stored)
        legacy_timeout = stored.get("chat_timeout_ms")
        if (
            isinstance(legacy_timeout, int)
            and not isinstance(legacy_timeout, bool)
            and legacy_timeout > 0
        ):
            stored["chat_timeout_ms"] = 0
        try:
            validated = {key: self._validate(key, item) for key, item in stored.items()}
        except SettingsRuntimeError:
            raise SettingsRuntimeError("SETTINGS_CORRUPT", "stored settings contain invalid values") from None
        return {"schema_version": 1, "revision": revision, "updated_at": value.get("updated_at"), "settings": validated}

    @staticmethod
    def _validate(key: str, value: Any) -> Any:
        if key == "language" and value in {"zh", "en"}:
            return value
        if key == "theme" and value in {"system", "light", "dark"}:
            return value
        if key == "custom_theme" and isinstance(value, str):
            normalized = value.strip()
            if not normalized or re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", normalized):
                return normalized
        if key == "log_retention_days" and isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 365:
            return value
        if key == "chat_timeout_ms" and value == 0 and not isinstance(value, bool):
            return value
        if key == "file_open_target" and value in {"system", "vscode"}:
            return value
        if key == "integrated_shell" and value in {"powershell", "cmd", "bash"}:
            return value
        if key == "terminal_position" and value in {"bottom", "right"}:
            return value
        if key in {"show_bottom_panel", "allow_force_push", "draft_pull_requests", "auto_delete_worktrees", "translucent_sidebar"} and isinstance(value, bool):
            return value
        if key == "branch_prefix" and isinstance(value, str):
            normalized = value.strip().replace("\\", "/")
            if normalized and len(normalized) <= 64 and re.fullmatch(r"[A-Za-z0-9._/-]+", normalized) and ".." not in normalized and not normalized.startswith("/"):
                return normalized if normalized.endswith("/") else normalized + "/"
        if key == "pr_merge_method" and value in {"merge", "squash", "rebase"}:
            return value
        if key == "worktree_retention_limit" and isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 100:
            return value
        if key == "accent_color" and isinstance(value, str) and re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
            return value.lower()
        if key == "reasoning_effort" and value in {"low", "medium", "high", "ultra"}:
            return value
        raise SettingsRuntimeError("INVALID_SETTING_VALUE", f"invalid value for {key}")

    @staticmethod
    def _public(document: dict[str, Any]) -> dict[str, Any]:
        return {
            "schema_version": document["schema_version"],
            "revision": document["revision"],
            "updated_at": document["updated_at"],
            "settings": dict(document["settings"]),
            "schema": SCHEMA,
            "sensitive_settings_supported": False,
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
