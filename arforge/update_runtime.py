"""Explicit, cached update availability checks with no automatic installation."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from urllib.request import Request, urlopen

from arforge.paths import data_path

_CACHE_SECONDS = 21_600


class UpdateCheckError(Exception):
    pass


def current_version() -> str:
    try:
        from importlib.metadata import version

        return version("arforge-agent")
    except Exception:
        return "0.0.0"


def check_for_update(*, opener=urlopen, force: bool = False) -> dict[str, object]:
    """Fetch package metadata only when the user explicitly requests a check."""
    from arforge.core.runtime_sandbox import decide_network_egress

    metadata_url = os.environ.get("ARFORGE_UPDATE_METADATA_URL", "").strip()
    if not metadata_url:
        raise UpdateCheckError("private build update source is not configured")
    if not metadata_url.startswith(("https://", "http://127.0.0.1:", "http://localhost:")):
        raise UpdateCheckError("update metadata URL must use HTTPS or a loopback HTTP address")
    network = decide_network_egress(f"curl {metadata_url}", mode="workspace-write")
    if not network.allowed:
        raise UpdateCheckError(network.reason or "update network request is blocked")
    cache_path = Path(data_path("cache", "update_check.json"))
    cached = _read_cache(cache_path)
    if not force and cached and float(cached.get("checked_at", 0)) + _CACHE_SECONDS > time.time():
        return _format_result(cached, cached=True)
    request = Request(metadata_url, headers={"Accept": "application/json", "User-Agent": "arforge-agent-update-check"})
    try:
        response = opener(request, timeout=8)
        try:
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            response.close()
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UpdateCheckError(f"update check failed: {exc.__class__.__name__}") from None
    latest = payload.get("info", {}).get("version") if isinstance(payload, dict) else None
    if not isinstance(latest, str) or not _version_key(latest):
        raise UpdateCheckError("update metadata did not contain a valid version")
    document = {"checked_at": time.time(), "latest_version": latest, "current_version": current_version()}
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return _format_result(document, cached=False)


def _read_cache(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _format_result(value: dict[str, object], *, cached: bool) -> dict[str, object]:
    current = str(value.get("current_version") or current_version())
    latest = str(value.get("latest_version") or current)
    return {"current_version": current, "latest_version": latest, "update_available": _version_key(latest) > _version_key(current), "cached": cached}


def _version_key(value: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", value)
    numeric = [int(part) for part in parts[:4]]
    return tuple((numeric + [0, 0, 0, 0])[:4])
