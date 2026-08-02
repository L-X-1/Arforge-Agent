"""Provider-neutral local and authenticated HTTP trigger management."""

from __future__ import annotations

import json
import math
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from arforge.mcp_client_runtime import (
    EnvironmentTokenProvider,
    MCPClientError,
    TokenProvider,
    _validate_remote_url,
    environment_oauth_provider,
)
from arforge.security_guard import sanitize_log_message


MAX_TRIGGER_BODY_BYTES = 256 * 1024
MAX_TRIGGER_RESPONSE_BYTES = 100_000
MAX_TRIGGER_PROFILES = 16
MAX_TRIGGER_ID_CHARS = 128
_PROFILE_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_TRIGGER_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_HEADER_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,63}$")
_ACTIONS = frozenset({"list", "get", "create", "update", "run"})


class TriggerRuntimeError(RuntimeError):
    """Safe trigger error with a stable machine-readable code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = sanitize_log_message(message)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        del req, fp, code, msg, headers, newurl
        return None


def _default_opener():
    return build_opener(_NoRedirect()).open


def _validate_json_value(
    value: Any,
    depth: int = 0,
    *,
    code: str = "INVALID_BODY",
    subject: str = "trigger body",
) -> None:
    if depth > 12:
        raise TriggerRuntimeError(code, f"{subject} exceeds maximum nesting depth")
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise TriggerRuntimeError(code, f"{subject} keys must be strings")
        for item in value.values():
            _validate_json_value(item, depth + 1, code=code, subject=subject)
    elif isinstance(value, list):
        for item in value:
            _validate_json_value(item, depth + 1, code=code, subject=subject)
    elif isinstance(value, float) and not math.isfinite(value):
        raise TriggerRuntimeError(code, f"{subject} contains a non-finite number")
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise TriggerRuntimeError(
            code,
            f"unsupported {subject} type: {type(value).__name__}",
        )


def _clean_headers(headers: dict[str, str] | None) -> dict[str, str]:
    cleaned: dict[str, str] = {}
    for raw_name, raw_value in (headers or {}).items():
        if not isinstance(raw_name, str) or not _HEADER_NAME.fullmatch(raw_name):
            raise ValueError("trigger header name is invalid")
        if raw_name.casefold() in {"authorization", "cookie", "host", "proxy-authorization"}:
            raise ValueError(f"trigger header is managed by the host: {raw_name}")
        if (
            not isinstance(raw_value, str)
            or len(raw_value) > 2_048
            or "\r" in raw_value
            or "\n" in raw_value
            or "\x00" in raw_value
        ):
            raise ValueError(f"trigger header value is invalid: {raw_name}")
        cleaned[raw_name] = raw_value
    return cleaned


@dataclass(frozen=True)
class TriggerProfile:
    """Host-owned profile. Authentication values never enter public state."""

    name: str
    kind: str = "http"
    base_url: str = ""
    auth: TokenProvider | None = field(default=None, repr=False)
    headers: dict[str, str] = field(default_factory=dict, repr=False)
    timeout: float = 20.0

    def __post_init__(self) -> None:
        if not _PROFILE_NAME.fullmatch(self.name):
            raise ValueError("trigger profile name is invalid")
        if self.kind not in {"local", "http"}:
            raise ValueError("trigger profile kind must be local or http")
        object.__setattr__(self, "headers", _clean_headers(self.headers))
        object.__setattr__(self, "timeout", min(max(float(self.timeout), 0.1), 60.0))
        if self.kind == "local":
            if self.base_url or self.auth is not None or self.headers:
                raise ValueError("local trigger profile must not configure HTTP fields")
            return
        validated = _validate_remote_url(self.base_url, "base_url").rstrip("/")
        parsed = urlparse(validated)
        if parsed.query:
            raise ValueError("base_url must not contain a query string")
        if self.auth is None:
            raise ValueError("HTTP trigger profile requires host-managed authentication")
        object.__setattr__(self, "base_url", validated)

    def public(self) -> dict[str, Any]:
        result = {
            "name": self.name,
            "kind": self.kind,
            "base_url": self.base_url,
            "timeout": self.timeout,
            "header_names": sorted(self.headers),
        }
        if self.auth is not None:
            result["auth"] = self.auth.public()
        return result


def _profile_from_mapping(raw: Any) -> TriggerProfile:
    if not isinstance(raw, dict):
        raise ValueError("trigger profile must be an object")
    name = str(raw.get("name", "") or "")
    kind = str(raw.get("kind", "http") or "http")
    if kind == "local":
        return TriggerProfile(name=name, kind="local")
    auth_raw = raw.get("auth")
    if not isinstance(auth_raw, dict):
        raise ValueError("HTTP trigger profile auth must be an object")
    auth_type = str(auth_raw.get("type", "") or "")
    if auth_type == "bearer_environment":
        auth: TokenProvider = EnvironmentTokenProvider(
            str(auth_raw.get("environment_variable", "") or "")
        )
    elif auth_type == "oauth_client_credentials":
        scopes = auth_raw.get("scopes", [])
        if not isinstance(scopes, list) or not all(isinstance(item, str) for item in scopes):
            raise ValueError("OAuth scopes must be an array of strings")
        auth = environment_oauth_provider(
            str(auth_raw.get("token_url", "") or ""),
            str(auth_raw.get("client_id_environment", "") or ""),
            str(auth_raw.get("client_secret_environment", "") or ""),
            scopes=scopes,
            audience=str(auth_raw.get("audience", "") or ""),
        )
    else:
        raise ValueError("unsupported trigger authentication type")
    headers = raw.get("headers", {})
    if not isinstance(headers, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in headers.items()
    ):
        raise ValueError("trigger headers must be a string mapping")
    return TriggerProfile(
        name=name,
        kind="http",
        base_url=str(raw.get("base_url", "") or ""),
        auth=auth,
        headers=headers,
        timeout=float(raw.get("timeout", 20.0)),
    )


def profiles_from_environment(
    environ: dict[str, str] | os._Environ[str] = os.environ,
) -> list[TriggerProfile]:
    """Load host-owned profiles without accepting inline credential values."""

    configured = str(environ.get("ARFORGE_TRIGGER_PROFILES", "") or "").strip()
    profiles = [TriggerProfile(name="local", kind="local")]
    if not configured:
        return profiles
    try:
        payload = json.loads(configured)
    except json.JSONDecodeError as exc:
        raise ValueError("ARFORGE_TRIGGER_PROFILES is invalid JSON") from exc
    items = payload.get("profiles") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        raise ValueError("ARFORGE_TRIGGER_PROFILES must contain a profile array")
    for item in items:
        profile = _profile_from_mapping(item)
        if profile.name == "local":
            raise ValueError("the local trigger profile name is reserved")
        profiles.append(profile)
    return profiles


class TriggerManager:
    """Execute the common trigger lifecycle against local or HTTP profiles."""

    def __init__(
        self,
        profiles: list[TriggerProfile] | None = None,
        *,
        opener=None,
    ) -> None:
        selected = list(profiles or profiles_from_environment())
        if not 1 <= len(selected) <= MAX_TRIGGER_PROFILES:
            raise ValueError(f"trigger profiles must contain 1 to {MAX_TRIGGER_PROFILES} items")
        names = [profile.name for profile in selected]
        if len(names) != len(set(names)):
            raise ValueError("trigger profile names must be unique")
        self._profiles = {profile.name: profile for profile in selected}
        self._opener = opener or _default_opener()
        self._request_lock = threading.RLock()

    def profiles(self) -> list[dict[str, Any]]:
        return [
            self._profiles[name].public()
            for name in sorted(self._profiles)
        ]

    def profile(self, name: str) -> TriggerProfile:
        profile_name = str(name or "local").strip()
        profile = self._profiles.get(profile_name)
        if profile is None:
            raise TriggerRuntimeError("PROFILE_NOT_FOUND", "trigger profile not found")
        return profile

    def execute(
        self,
        action: str,
        *,
        profile_name: str = "local",
        session_id: str,
        trigger_id: str = "",
        body: dict[str, Any] | None = None,
        local_manager=None,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        operation = str(action or "").strip()
        if operation not in _ACTIONS:
            raise TriggerRuntimeError("INVALID_ACTION", "trigger action is invalid")
        identifier = str(trigger_id or "").strip()
        if operation in {"get", "update", "run"} and not _TRIGGER_ID.fullmatch(identifier):
            raise TriggerRuntimeError("INVALID_TRIGGER_ID", "trigger_id is invalid")
        if operation in {"create", "update"}:
            if not isinstance(body, dict) or not body:
                raise TriggerRuntimeError("INVALID_BODY", f"{operation} requires a non-empty body")
            _validate_json_value(body)
            encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(encoded) > MAX_TRIGGER_BODY_BYTES:
                raise TriggerRuntimeError("BODY_TOO_LARGE", "trigger body exceeds the size limit")
        elif body not in (None, {}):
            raise TriggerRuntimeError("INVALID_BODY", f"{operation} does not accept a body")
        profile = self.profile(profile_name)
        if profile.kind == "local":
            return self._execute_local(
                operation,
                profile,
                session_id=session_id,
                trigger_id=identifier,
                body=body,
                local_manager=local_manager,
            )
        return self._execute_http(
            operation,
            profile,
            trigger_id=identifier,
            body=body,
            cancel_event=cancel_event,
        )

    @staticmethod
    def _execute_local(
        action: str,
        profile: TriggerProfile,
        *,
        session_id: str,
        trigger_id: str,
        body: dict[str, Any] | None,
        local_manager,
    ) -> dict[str, Any]:
        if local_manager is None:
            from arforge.scheduled_prompt_runtime import get_scheduled_prompt_manager

            local_manager = get_scheduled_prompt_manager()
        if action == "list":
            try:
                items = local_manager.list(session_id)
            except ValueError as exc:
                raise TriggerRuntimeError("INVALID_BODY", str(exc)) from None
            data: Any = {"items": items, "count": len(items)}
        elif action == "get":
            try:
                data = local_manager.get(session_id, trigger_id)
            except ValueError as exc:
                code = "TRIGGER_NOT_FOUND" if str(exc) == "scheduled prompt not found" else "INVALID_BODY"
                raise TriggerRuntimeError(code, str(exc)) from None
        elif action == "create":
            assert body is not None
            allowed = {
                "name",
                "cron",
                "cron_expression",
                "prompt",
                "recurring",
                "durable",
                "enabled",
            }
            unexpected = sorted(set(body) - allowed)
            if unexpected:
                raise TriggerRuntimeError(
                    "INVALID_BODY",
                    f"unsupported local trigger fields: {', '.join(unexpected)}",
                )
            expression = body.get("cron_expression", body.get("cron"))
            if expression is None or "prompt" not in body:
                raise TriggerRuntimeError(
                    "INVALID_BODY",
                    "local trigger create requires cron_expression and prompt",
                )
            try:
                data = local_manager.create(
                    session_id,
                    expression,
                    body["prompt"],
                    recurring=body.get("recurring", True),
                    durable=body.get("durable", True),
                    name=body.get("name", ""),
                    enabled=body.get("enabled", True),
                )
            except ValueError as exc:
                raise TriggerRuntimeError("INVALID_BODY", str(exc)) from None
        elif action == "update":
            assert body is not None
            try:
                data = local_manager.update(session_id, trigger_id, body)
            except ValueError as exc:
                code = "TRIGGER_NOT_FOUND" if str(exc) == "scheduled prompt not found" else "INVALID_BODY"
                raise TriggerRuntimeError(code, str(exc)) from None
        else:
            try:
                data = local_manager.run_now(session_id, trigger_id)
            except ValueError as exc:
                code = "TRIGGER_NOT_FOUND" if str(exc) == "scheduled prompt not found" else "INVALID_BODY"
                raise TriggerRuntimeError(code, str(exc)) from None
        return {
            "profile": profile.name,
            "kind": profile.kind,
            "action": action,
            "status": 200,
            "ok": True,
            "data": data,
        }

    def _execute_http(
        self,
        action: str,
        profile: TriggerProfile,
        *,
        trigger_id: str,
        body: dict[str, Any] | None,
        cancel_event: threading.Event | None,
    ) -> dict[str, Any]:
        if cancel_event is not None and cancel_event.is_set():
            raise TriggerRuntimeError("CANCELLED", "trigger request was cancelled")
        url = profile.base_url
        if action in {"get", "update", "run"}:
            url += "/" + quote(trigger_id, safe="")
        if action == "run":
            url += "/run"
        method = "GET" if action in {"list", "get"} else "POST"
        payload = None
        if action in {"create", "update"}:
            payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        elif action == "run":
            payload = b"{}"
        try:
            token = profile.auth.token()
        except MCPClientError as exc:
            raise TriggerRuntimeError(exc.code, exc.message) from None
        except Exception as exc:  # noqa: BLE001 - provider internals must not leak
            raise TriggerRuntimeError(
                "AUTH_FAILED",
                f"trigger authentication failed: {exc.__class__.__name__}",
            ) from None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "Arforge-Agent/trigger-runtime",
            **profile.headers,
        }
        request = Request(url, data=payload, headers=headers, method=method)
        with self._request_lock:
            try:
                response = self._opener(request, timeout=profile.timeout)
            except HTTPError as exc:
                response = exc
            except (OSError, URLError) as exc:
                raise TriggerRuntimeError(
                    "NETWORK_ERROR",
                    f"trigger request failed: {exc.__class__.__name__}",
                ) from None
            try:
                status = int(getattr(response, "status", getattr(response, "code", 0)) or 0)
                chunks: list[bytes] = []
                total = 0
                while True:
                    if cancel_event is not None and cancel_event.is_set():
                        raise TriggerRuntimeError("CANCELLED", "trigger request was cancelled")
                    chunk = response.read(min(64 * 1024, MAX_TRIGGER_RESPONSE_BYTES + 1 - total))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                    if total > MAX_TRIGGER_RESPONSE_BYTES:
                        raise TriggerRuntimeError(
                            "RESPONSE_TOO_LARGE",
                            "trigger response exceeds the size limit",
                        )
            finally:
                response.close()
        try:
            data = json.loads(b"".join(chunks).decode("utf-8")) if chunks else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise TriggerRuntimeError("INVALID_RESPONSE", "trigger response is not valid JSON") from None
        _validate_json_value(
            data,
            code="INVALID_RESPONSE",
            subject="trigger response",
        )
        return {
            "profile": profile.name,
            "kind": profile.kind,
            "action": action,
            "status": status,
            "ok": 200 <= status < 300,
            "data": data,
        }


_GLOBAL_MANAGER: TriggerManager | None = None
_GLOBAL_LOCK = threading.Lock()


def get_trigger_manager() -> TriggerManager:
    global _GLOBAL_MANAGER
    with _GLOBAL_LOCK:
        if _GLOBAL_MANAGER is None:
            _GLOBAL_MANAGER = TriggerManager()
        return _GLOBAL_MANAGER


def set_trigger_manager(manager: TriggerManager | None) -> None:
    global _GLOBAL_MANAGER
    with _GLOBAL_LOCK:
        _GLOBAL_MANAGER = manager


__all__ = [
    "MAX_TRIGGER_BODY_BYTES",
    "MAX_TRIGGER_RESPONSE_BYTES",
    "TriggerManager",
    "TriggerProfile",
    "TriggerRuntimeError",
    "get_trigger_manager",
    "profiles_from_environment",
    "set_trigger_manager",
]
