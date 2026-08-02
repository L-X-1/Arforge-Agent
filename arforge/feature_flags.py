"""Local, auditable feature flags for controlled capability rollout.

Flags are registered in code and may be overridden by a local state file or a
process environment variable. Environment values have the highest precedence,
which gives operators a reliable emergency kill switch without introducing a
remote configuration dependency.
"""

from __future__ import annotations

import json
import hashlib
import hmac
import os
import re
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from arforge.paths import get_arforge_home

_SAFE_FLAG_ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}
_REMOTE_URL_ENV = "ARFORGE_FEATURE_CONFIG_URL"
_REMOTE_KEY_ENV = "ARFORGE_FEATURE_CONFIG_HMAC_KEY"
_REMOTE_TTL_SECONDS = 900
_MAX_REMOTE_TTL_SECONDS = 86_400


@dataclass(frozen=True)
class FeatureDefinition:
    flag_id: str
    default: bool
    description: str


DEFAULT_FEATURES = (
    FeatureDefinition("file_history", True, "Session-scoped file revision history and diff re-review."),
    FeatureDefinition("session_export", True, "Safe export of visible session content and artifact metadata."),
    FeatureDefinition("multimodal_diagnosis", True, "Local screenshot and document diagnostic workflow."),
    FeatureDefinition("deferred_tool_loading", True, "Run-scoped discovery and loading of deferred tool schemas."),
    FeatureDefinition(
        "desktop_modal_keyboard",
        False,
        "Optional insert/navigation keyboard modes for the desktop chat composer.",
    ),
)


class FeatureFlagError(ValueError):
    """Raised when an operator supplies an invalid feature flag change."""


class FeatureFlagRegistry:
    """Resolve registered flags from defaults, local overrides, and environment."""

    def __init__(
        self,
        definitions: tuple[FeatureDefinition, ...] = DEFAULT_FEATURES,
        *,
        state_path: Path | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        self._definitions = {item.flag_id: item for item in definitions}
        if len(self._definitions) != len(definitions):
            raise FeatureFlagError("feature flag ids must be unique")
        if any(not _SAFE_FLAG_ID.fullmatch(item.flag_id) for item in definitions):
            raise FeatureFlagError("feature flag ids must be lowercase snake_case")
        self._state_path = state_path or get_arforge_home() / "feature_flags.json"
        self._environ = environ if environ is not None else os.environ
        self._lock = threading.RLock()

    @property
    def state_path(self) -> Path:
        return self._state_path

    @property
    def remote_state_path(self) -> Path:
        return self._state_path.with_name("feature_flags_remote.json")

    def enabled(self, flag_id: str) -> bool:
        return bool(self.get(flag_id)["enabled"])

    def get(self, flag_id: str) -> dict[str, object]:
        if flag_id not in self._definitions:
            raise FeatureFlagError(f"unknown feature flag: {flag_id}")
        overrides, problems = self._load_overrides()
        remote_overrides, remote_problems = self._load_remote_overrides()
        problems.extend(remote_problems)
        environment_problem = self._environment_problem(flag_id)
        if environment_problem:
            problems.append(environment_problem)
        definition = self._definitions[flag_id]
        enabled = definition.default
        source = "default"
        if flag_id in remote_overrides:
            enabled = remote_overrides[flag_id]
            source = "remote_cache"
        if flag_id in overrides:
            enabled = overrides[flag_id]
            source = "local_override"
        environment = self._environment_override(flag_id)
        if environment is not None:
            enabled = environment
            source = "environment"
        return {
            **asdict(definition),
            "enabled": enabled,
            "source": source,
            "environment_variable": _environment_key(flag_id),
            "problems": problems,
        }

    def list(self) -> dict[str, object]:
        overrides, problems = self._load_overrides()
        remote_overrides, remote_problems = self._load_remote_overrides()
        problems.extend(remote_problems)
        items = []
        for definition in self._definitions.values():
            enabled = definition.default
            source = "default"
            if definition.flag_id in remote_overrides:
                enabled = remote_overrides[definition.flag_id]
                source = "remote_cache"
            if definition.flag_id in overrides:
                enabled = overrides[definition.flag_id]
                source = "local_override"
            environment = self._environment_override(definition.flag_id)
            environment_problem = self._environment_problem(definition.flag_id)
            if environment_problem:
                problems.append(environment_problem)
            if environment is not None:
                enabled = environment
                source = "environment"
            items.append(
                {
                    **asdict(definition),
                    "enabled": enabled,
                    "source": source,
                    "environment_variable": _environment_key(definition.flag_id),
                }
            )
        return {
            "schema_version": 1,
            "path": str(self._state_path),
            "items": items,
            "count": len(items),
            "problems": problems,
        }

    def set_override(self, flag_id: str, enabled: bool) -> dict[str, object]:
        if flag_id not in self._definitions:
            raise FeatureFlagError(f"unknown feature flag: {flag_id}")
        if not isinstance(enabled, bool):
            raise FeatureFlagError("enabled must be a boolean")
        with self._lock:
            overrides, _problems = self._load_overrides()
            overrides[flag_id] = enabled
            self._write_overrides(overrides)
        return self.get(flag_id)

    def clear_override(self, flag_id: str) -> dict[str, object]:
        if flag_id not in self._definitions:
            raise FeatureFlagError(f"unknown feature flag: {flag_id}")
        with self._lock:
            overrides, _problems = self._load_overrides()
            overrides.pop(flag_id, None)
            self._write_overrides(overrides)
        return self.get(flag_id)

    def refresh_remote_config(self, *, timeout_seconds: float = 10.0, opener=urlopen) -> dict[str, object]:
        """Explicitly fetch and verify a signed remote rollout configuration.

        Remote configuration is never fetched while resolving a flag. Operators
        must invoke this method through an explicit CLI or Bridge action. The
        response body is authenticated with an HMAC key held only in the local
        environment, then cached for bounded offline use.
        """
        url = str(self._environ.get(_REMOTE_URL_ENV, "")).strip()
        key = str(self._environ.get(_REMOTE_KEY_ENV, ""))
        _validate_remote_url(url)
        if not key:
            raise FeatureFlagError(f"{_REMOTE_KEY_ENV} must be configured before refreshing remote flags")
        cached = self._read_remote_cache_raw()
        headers = {"Accept": "application/json"}
        if cached.get("url") == url and isinstance(cached.get("etag"), str) and cached["etag"]:
            headers["If-None-Match"] = cached["etag"]
        request = Request(url, headers=headers, method="GET")
        try:
            response = opener(request, timeout=timeout_seconds)
            try:
                body = response.read()
                response_headers = response.headers
                etag = response_headers.get("ETag", "")
                signature = response_headers.get("X-Arforge-Feature-Signature", "")
            finally:
                response.close()
        except HTTPError as exc:
            if exc.code == 304 and cached.get("url") == url:
                return {"status": "not_modified", "source": "remote_cache", "expires_at": cached.get("expires_at", 0)}
            raise FeatureFlagError(f"remote feature configuration request failed: HTTP {exc.code}") from None
        except OSError as exc:
            raise FeatureFlagError(f"remote feature configuration request failed: {exc.__class__.__name__}") from None
        _verify_signature(body, signature, key)
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FeatureFlagError(f"remote feature configuration is invalid JSON: {exc.__class__.__name__}") from None
        overrides, ttl_seconds = self._validate_remote_payload(payload)
        now = time.time()
        document = {
            "schema_version": 1,
            "url": url,
            "etag": etag,
            "fetched_at": now,
            "expires_at": now + ttl_seconds,
            "overrides": overrides,
        }
        with self._lock:
            self.remote_state_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.remote_state_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary.replace(self.remote_state_path)
        return {"status": "refreshed", "source": "remote_cache", "count": len(overrides), "expires_at": document["expires_at"]}

    def _load_overrides(self) -> tuple[dict[str, bool], list[str]]:
        with self._lock:
            if not self._state_path.is_file():
                return {}, []
            try:
                payload = json.loads(self._state_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                return {}, [f"cannot read local overrides: {exc}"]
        if not isinstance(payload, dict) or not isinstance(payload.get("overrides", {}), dict):
            return {}, ["local overrides must contain an object named overrides"]
        overrides: dict[str, bool] = {}
        problems: list[str] = []
        for flag_id, enabled in payload["overrides"].items():
            if flag_id not in self._definitions:
                problems.append(f"unknown local override ignored: {flag_id}")
            elif not isinstance(enabled, bool):
                problems.append(f"non-boolean local override ignored: {flag_id}")
            else:
                overrides[flag_id] = enabled
        return overrides, problems

    def _write_overrides(self, overrides: dict[str, bool]) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        target = self._state_path
        temporary = target.with_suffix(f"{target.suffix}.tmp")
        temporary.write_text(
            json.dumps({"schema_version": 1, "overrides": overrides}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(target)

    def _read_remote_cache_raw(self) -> dict[str, object]:
        try:
            payload = json.loads(self.remote_state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _load_remote_overrides(self) -> tuple[dict[str, bool], list[str]]:
        url = str(self._environ.get(_REMOTE_URL_ENV, "")).strip()
        key = str(self._environ.get(_REMOTE_KEY_ENV, ""))
        if not url and not key:
            return {}, []
        if not url or not key:
            return {}, [f"remote flags require both {_REMOTE_URL_ENV} and {_REMOTE_KEY_ENV}"]
        try:
            _validate_remote_url(url)
        except FeatureFlagError as exc:
            return {}, [str(exc)]
        cached = self._read_remote_cache_raw()
        if cached.get("url") != url:
            return {}, []
        expires_at = cached.get("expires_at")
        if not isinstance(expires_at, (int, float)) or expires_at <= time.time():
            return {}, ["remote feature configuration cache is missing or expired"]
        raw_overrides = cached.get("overrides")
        if not isinstance(raw_overrides, dict):
            return {}, ["remote feature configuration cache is malformed"]
        overrides: dict[str, bool] = {}
        problems: list[str] = []
        for flag_id, enabled in raw_overrides.items():
            if flag_id not in self._definitions:
                problems.append(f"unknown remote override ignored: {flag_id}")
            elif not isinstance(enabled, bool):
                problems.append(f"non-boolean remote override ignored: {flag_id}")
            else:
                overrides[flag_id] = enabled
        return overrides, problems

    def _validate_remote_payload(self, payload: object) -> tuple[dict[str, bool], int]:
        if not isinstance(payload, dict) or not isinstance(payload.get("overrides"), dict):
            raise FeatureFlagError("remote feature configuration must contain an overrides object")
        raw_ttl = payload.get("ttl_seconds", _REMOTE_TTL_SECONDS)
        if isinstance(raw_ttl, bool):
            raise FeatureFlagError("remote feature configuration ttl_seconds must be an integer")
        try:
            ttl_seconds = int(raw_ttl)
        except (TypeError, ValueError):
            raise FeatureFlagError("remote feature configuration ttl_seconds must be an integer") from None
        if not 1 <= ttl_seconds <= _MAX_REMOTE_TTL_SECONDS:
            raise FeatureFlagError(f"remote feature configuration ttl_seconds must be between 1 and {_MAX_REMOTE_TTL_SECONDS}")
        overrides: dict[str, bool] = {}
        for flag_id, enabled in payload["overrides"].items():
            if flag_id not in self._definitions:
                continue
            if not isinstance(enabled, bool):
                raise FeatureFlagError(f"remote override must be boolean: {flag_id}")
            overrides[flag_id] = enabled
        return overrides, ttl_seconds

    def _environment_override(self, flag_id: str) -> bool | None:
        raw = self._environ.get(_environment_key(flag_id))
        if raw is None:
            return None
        normalized = raw.strip().casefold()
        if normalized in _TRUE_VALUES:
            return True
        if normalized in _FALSE_VALUES:
            return False
        return None

    def _environment_problem(self, flag_id: str) -> str | None:
        raw = self._environ.get(_environment_key(flag_id))
        if raw is None or raw.strip().casefold() in _TRUE_VALUES | _FALSE_VALUES:
            return None
        return f"invalid environment override ignored: {_environment_key(flag_id)}"


def _environment_key(flag_id: str) -> str:
    return f"ARFORGE_FEATURE_{flag_id.upper()}"


def _validate_remote_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise FeatureFlagError("remote feature configuration URL must be an HTTPS URL without credentials")


def _verify_signature(body: bytes, signature: str, key: str) -> None:
    normalized = signature.removeprefix("sha256=").strip().casefold()
    expected = hmac.new(key.encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not normalized or not hmac.compare_digest(normalized, expected):
        raise FeatureFlagError("remote feature configuration signature is invalid")


_default_registry: FeatureFlagRegistry | None = None
_default_registry_lock = threading.Lock()


def get_feature_flags() -> FeatureFlagRegistry:
    """Return the process-wide feature flag registry."""
    global _default_registry
    with _default_registry_lock:
        if _default_registry is None:
            _default_registry = FeatureFlagRegistry()
        return _default_registry
