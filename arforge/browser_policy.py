"""Fail-closed policy and verification contracts for browser actions.

The Chromium runtime is an executor/observer.  This module keeps the safety
decisions deterministic and testable without launching a browser or relying on
the page to tell us what it did.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlparse


class BrowserPolicyError(ValueError):
    """Raised when a browser target or action violates the execution contract."""


@dataclass(frozen=True)
class BrowserActionPlan:
    raw: str
    kind: str
    risk_level: str
    requires_confirmation: bool
    destructive: bool = False


_DESTRUCTIVE_MARKERS = (
    "delete",
    "remove",
    "destroy",
    "revoke",
    "publish",
    "submit",
    "send",
    "purchase",
    "checkout",
    "pay",
    "confirm",
    "upload",
    "删除",
    "移除",
    "销毁",
    "撤销",
    "发布",
    "提交",
    "发送",
    "购买",
    "付款",
    "确认",
)
_CREDENTIAL_QUERY_MARKERS = (
    "api_key",
    "apikey",
    "access_token",
    "authorization",
    "auth_token",
    "cookie",
    "password",
    "passwd",
    "secret",
    "session",
    "token",
)
_SAFE_KEYS = {"arrowleft", "arrowup", "arrowright", "arrowdown", "escape", "tab"}


def _normalise_text(value: object) -> str:
    return " ".join(str(value or "").casefold().split())


def _action_target(raw: str) -> str:
    prefix, separator, rest = raw.partition(":")
    if not separator:
        return ""
    if prefix.casefold() in {"fill", "select", "upload"}:
        _, _, target = rest.partition(":")
        return f"{rest.partition(':')[0]} {target}"
    return rest


def classify_browser_action(action: str) -> BrowserActionPlan:
    """Classify one bounded browser action before any browser is launched."""

    raw = str(action or "").strip()
    if not raw:
        raise BrowserPolicyError("browser action must not be empty")
    prefix, separator, rest = raw.partition(":")
    name = prefix.casefold()
    if not separator or not rest:
        raise BrowserPolicyError(f"invalid browser action: {raw}")

    if name == "wait":
        try:
            milliseconds = int(rest)
        except ValueError as exc:
            raise BrowserPolicyError("wait action requires an integer duration") from exc
        if not 0 <= milliseconds <= 10_000:
            raise BrowserPolicyError("wait action must be between 0 and 10000ms")
        return BrowserActionPlan(raw, "observation_wait", "low", False)

    if name == "navigate":
        return BrowserActionPlan(raw, "navigation", "low", False)

    target = _action_target(raw)
    destructive = any(marker in _normalise_text(target) for marker in _DESTRUCTIVE_MARKERS)

    if name == "press":
        key = _normalise_text(rest)
        if key in _SAFE_KEYS:
            return BrowserActionPlan(raw, "navigation_key", "low", False)
        # Enter/Space can submit a form even when the selector is not visible.
        return BrowserActionPlan(raw, "form_key", "high" if key in {"enter", "space"} else "medium", True, key in {"enter", "space"})

    if name in {"fill", "select", "check", "uncheck", "touch"}:
        return BrowserActionPlan(raw, "form" if name != "touch" else "touch", "medium", True, destructive)

    if name == "click":
        if "download" in _normalise_text(target) or "下载" in target:
            return BrowserActionPlan(raw, "download", "high", True, False)
        return BrowserActionPlan(
            raw,
            "destructive_click" if destructive else "click",
            "high" if destructive else "medium",
            True,
            destructive,
        )

    if name == "upload":
        return BrowserActionPlan(raw, "upload", "high", True, True)

    if name == "download":
        return BrowserActionPlan(raw, "download", "high", True, False)

    raise BrowserPolicyError(
        "unsupported browser action; use navigate, press, click, touch, fill, select, "
        "check, uncheck, upload, download, or wait"
    )


def classify_browser_actions(actions: list[str] | None) -> tuple[BrowserActionPlan, ...]:
    plans = tuple(classify_browser_action(action) for action in (actions or []))
    if len(plans) > 24:
        raise BrowserPolicyError("browser action batch exceeds the 24-action limit")
    return plans


def _validate_url(value: str, *, field: str) -> str:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https", "file"}:
        raise BrowserPolicyError(f"{field} must use http(s) or file scheme")
    if parsed.scheme in {"http", "https"} and not parsed.hostname:
        raise BrowserPolicyError(f"{field} must include a host")
    if parsed.username is not None or parsed.password is not None:
        raise BrowserPolicyError(f"{field} must not contain inline credentials")
    query_keys = {key.casefold() for key, _value in parse_qsl(parsed.query, keep_blank_values=True)}
    if query_keys.intersection(_CREDENTIAL_QUERY_MARKERS):
        raise BrowserPolicyError(f"{field} must not carry credentials in its query string")
    return raw


def validate_browser_target_url(value: str) -> str:
    """Validate an initial or redirect URL without making a network request."""

    return _validate_url(value, field="browser URL")


def _origin(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme == "file":
        return "file://"
    host = (parsed.hostname or "").casefold()
    try:
        port = parsed.port
    except ValueError as exc:
        raise BrowserPolicyError("browser URL contains an invalid port") from exc
    default_port = 443 if parsed.scheme == "https" else 80
    suffix = "" if port in (None, default_port) else f":{port}"
    return f"{parsed.scheme}://{host}{suffix}"


def normalise_allowed_origins(origins: list[str] | None) -> tuple[str, ...]:
    result: list[str] = []
    for value in origins or []:
        raw = _validate_url(str(value), field="allowed origin")
        parsed = urlparse(raw)
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise BrowserPolicyError("allowed origin must not contain a path, query, or fragment")
        origin = _origin(raw)
        if origin not in result:
            result.append(origin)
    return tuple(result)


def _file_path(url: str) -> Path:
    parsed = urlparse(url)
    path = unquote(parsed.path)
    if parsed.netloc and parsed.netloc.casefold() not in {"", "localhost"}:
        path = f"//{parsed.netloc}{path}"
    if re.match(r"^/[A-Za-z]:/", path):
        path = path[1:]
    return Path(path).resolve()


def validate_redirect(
    initial_url: str,
    candidate_url: str,
    *,
    workspace: Path,
    allowed_origins: list[str] | tuple[str, ...] | None = None,
) -> str:
    """Allow same-origin redirects, or explicitly allowlisted origins only."""

    initial = validate_browser_target_url(initial_url)
    candidate = validate_browser_target_url(candidate_url)
    allowed = normalise_allowed_origins(list(allowed_origins or []))
    if not allowed:
        allowed = (_origin(initial),)
    if _origin(candidate) not in allowed:
        raise BrowserPolicyError(
            f"browser redirect crossed the origin boundary: {_origin(initial)} -> {_origin(candidate)}"
        )
    if urlparse(candidate).scheme == "file":
        resolved_workspace = workspace.resolve()
        try:
            _file_path(candidate).relative_to(resolved_workspace)
        except ValueError as exc:
            raise BrowserPolicyError("browser file redirect escaped the active workspace") from exc
    return candidate


def verify_browser_state(snapshot: dict[str, Any], expected: dict[str, Any] | None = None) -> dict[str, Any]:
    """Verify final URL/DOM evidence; never infer success from an action result."""

    if expected is None:
        return {
            "status": "OBSERVATION_ONLY",
            "passed": False,
            "failures": ["no expected final state was supplied"],
        }
    if not isinstance(expected, dict):
        return {"status": "FAILED", "passed": False, "failures": ["expected_state must be an object"]}

    failures: list[str] = []
    final_url = str(snapshot.get("url") or "")
    body_text = str(snapshot.get("bodyText") or "")
    url_exact = expected.get("url_exact") or expected.get("url")
    url_prefix = expected.get("url_prefix")
    if url_exact is not None and final_url != str(url_exact):
        failures.append(f"final URL does not equal {url_exact!r}")
    if url_prefix is not None and not final_url.startswith(str(url_prefix)):
        failures.append(f"final URL does not start with {url_prefix!r}")
    for text in expected.get("text", expected.get("contains", [])) or []:
        if str(text) not in body_text:
            failures.append(f"expected DOM text missing: {text!r}")
    for text in expected.get("absent_text", []) or []:
        if str(text) in body_text:
            failures.append(f"forbidden DOM text present: {text!r}")
    ready_state = expected.get("ready_state")
    if ready_state is not None and snapshot.get("readyState") != ready_state:
        failures.append(f"readyState is {snapshot.get('readyState')!r}, expected {ready_state!r}")
    return {
        "status": "PASSED" if not failures else "FAILED",
        "passed": not failures,
        "failures": failures,
    }


__all__ = [
    "BrowserActionPlan",
    "BrowserPolicyError",
    "classify_browser_action",
    "classify_browser_actions",
    "normalise_allowed_origins",
    "validate_browser_target_url",
    "validate_redirect",
    "verify_browser_state",
]
