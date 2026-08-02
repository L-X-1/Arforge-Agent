"""Local, non-executing enablement preferences for discovered MCP plugins."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from arforge.paths import data_path
from arforge.database.sqlite_runtime import ProfileWriterLock
from arforge.profile_state import atomic_write_json

_LOCK = threading.RLock()
_STATE_VERSION = 1


def _state_path() -> Path:
    return Path(data_path("config")) / "plugin_state.json"


def _state_lock_path() -> Path:
    return Path(data_path("config")) / "plugin-state.lock"


def load_plugin_overrides() -> dict[str, bool]:
    """Return manifest-path keyed overrides, ignoring malformed local state."""
    with _LOCK:
        path = _state_path()
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        overrides = payload.get("enabled_overrides", {}) if isinstance(payload, dict) else {}
        if not isinstance(overrides, dict):
            return {}
        return {str(key): value for key, value in overrides.items() if isinstance(key, str) and isinstance(value, bool)}


def set_plugin_enabled(manifest_path: Path, enabled: bool) -> dict[str, bool]:
    """Persist an enablement override without changing third-party manifests."""
    key = str(Path(manifest_path).expanduser().resolve())
    with _LOCK, ProfileWriterLock(_state_lock_path()):
        overrides = load_plugin_overrides()
        overrides[key] = bool(enabled)
        atomic_write_json(
            _state_path(),
            {
                "version": _STATE_VERSION,
                "enabled_overrides": overrides,
            },
        )
    return {"manifest_path": key, "enabled": bool(enabled)}
