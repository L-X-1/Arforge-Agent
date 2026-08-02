"""Transport-level provider fault injection for staging validation.

The proxy binds only to loopback, never logs credentials or prompt bodies, and
forwards the final recovery request to the configured real provider.  Faults
therefore cross the same HTTP/TCP boundary used by the provider SDK instead of
being represented by a locally raised Python exception.
"""

from __future__ import annotations

import hashlib
import json
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import urlparse

import httpx


_FAULTS = {
    "http_429": {
        "status": 429,
        "error_type": "rate_limit_error",
        "error_code": "arforge_injected_429",
    },
    "http_503": {
        "status": 503,
        "error_type": "server_error",
        "error_code": "arforge_injected_503",
    },
    "connection_drop": {
        "status": None,
        "error_type": "connection_error",
        "error_code": "arforge_injected_connection_drop",
    },
}

_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

PROVIDER_PROBE_MAX_TOKENS = 64


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def validate_transport_fault_evidence(fault: Any) -> list[str]:
    """Return fail-closed schema errors for retained transport-fault evidence."""

    if not isinstance(fault, dict):
        return ["fault_injection"]
    missing: list[str] = []
    if fault.get("schema_version") != 1:
        missing.append("fault_injection.schema_version=1")
    if fault.get("injection_layer") != "loopback_http_tcp_proxy":
        missing.append("fault_injection.injection_layer=loopback_http_tcp_proxy")
    observations = fault.get("scenarios")
    by_name = {
        str(item.get("scenario") or ""): item
        for item in observations
        if isinstance(item, dict)
    } if isinstance(observations, list) else {}
    for scenario in ("http_429", "http_503", "connection_drop"):
        item = by_name.get(scenario)
        if not isinstance(item, dict):
            missing.append(f"fault_injection.scenarios.{scenario}")
            continue
        if item.get("injection_layer") != "loopback_http_tcp_proxy":
            missing.append(f"fault_injection.scenarios.{scenario}.injection_layer")
        if int(item.get("proxy_requests") or 0) < 1:
            missing.append(f"fault_injection.scenarios.{scenario}.proxy_requests>=1")
        digest = str(item.get("request_body_sha256") or "")
        if len(digest) != 64 or any(character not in "0123456789abcdefABCDEF" for character in digest):
            missing.append(f"fault_injection.scenarios.{scenario}.request_body_sha256")
        if item.get("fault_detected") is not True:
            missing.append(f"fault_injection.scenarios.{scenario}.fault_detected=true")
        if item.get("false_success") is not False:
            missing.append(f"fault_injection.scenarios.{scenario}.false_success=false")
        if int(item.get("retry_proxy_requests") or 0) < 2:
            missing.append(f"fault_injection.scenarios.{scenario}.retry_proxy_requests>=2")
        for field in (
            "automatic_retry_recovered",
            "retry_content_valid",
            "retry_not_truncated",
        ):
            if item.get(field) is not True:
                missing.append(f"fault_injection.scenarios.{scenario}.{field}=true")
    recovery = fault.get("recovery")
    if not isinstance(recovery, dict):
        missing.append("fault_injection.recovery")
    else:
        for field in (
            "after_all_faults",
            "real_provider_request",
            "content_valid",
            "not_truncated",
        ):
            if recovery.get(field) is not True:
                missing.append(f"fault_injection.recovery.{field}=true")
        if not _timestamp(recovery.get("started_at_utc")):
            missing.append("fault_injection.recovery.started_at_utc")
        if not _timestamp(recovery.get("completed_at_utc")):
            missing.append("fault_injection.recovery.completed_at_utc")
    if fault.get("passed") is not True:
        missing.append("fault_injection.passed=true")
    return missing


@dataclass(frozen=True)
class ProxyEvent:
    scenario: str
    path: str
    request_body_sha256: str
    injected_at_utc: str
    status_code: int | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario,
            "path": self.path,
            "request_body_sha256": self.request_body_sha256,
            "injected_at_utc": self.injected_at_utc,
            "status_code": self.status_code,
        }


class _ProxyState:
    def __init__(self, upstream_base_url: str):
        parsed = urlparse(upstream_base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("fault proxy upstream must be an HTTP or HTTPS endpoint")
        self.upstream = parsed
        self.mode = "pass_through"
        self.remaining_faults = 0
        self.request_count = 0
        self.events: list[ProxyEvent] = []
        self.lock = threading.Lock()

    def arm(self, scenario: str, occurrences: int = 1) -> None:
        if scenario not in _FAULTS:
            raise ValueError(f"unsupported provider fault scenario: {scenario}")
        if occurrences <= 0:
            raise ValueError("fault occurrences must be positive")
        with self.lock:
            self.mode = scenario
            self.remaining_faults = occurrences

    def pass_through(self) -> None:
        with self.lock:
            self.mode = "pass_through"
            self.remaining_faults = 0

    def next_mode(self) -> str:
        with self.lock:
            self.request_count += 1
            mode = self.mode
            if mode in _FAULTS:
                self.remaining_faults -= 1
                if self.remaining_faults <= 0:
                    self.mode = "pass_through"
                    self.remaining_faults = 0
            return mode

    def record(self, scenario: str, path: str, body: bytes) -> ProxyEvent:
        event = ProxyEvent(
            scenario=scenario,
            path=path,
            request_body_sha256=hashlib.sha256(body).hexdigest(),
            injected_at_utc=_utc_now(),
            status_code=_FAULTS[scenario]["status"],
        )
        with self.lock:
            self.events.append(event)
        return event


class _FaultProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ArforgeFaultProxy/1"
    sys_version = ""

    def log_message(self, _format: str, *_args: Any) -> None:
        # Request headers contain credentials and request bodies contain prompts.
        return

    @property
    def _state(self) -> _ProxyState:
        return self.server.arforge_state  # type: ignore[attr-defined]

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else b""
        mode = self._state.next_mode()
        if mode in _FAULTS:
            self._state.record(mode, self.path, body)
            if mode == "connection_drop":
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.connection.close()
                self.close_connection = True
                return
            self._write_fault_response(mode)
            return
        self._forward(body)

    def _write_fault_response(self, scenario: str) -> None:
        definition = _FAULTS[scenario]
        payload = json.dumps(
            {
                "error": {
                    "message": f"Arforge staging injected {scenario}",
                    "type": definition["error_type"],
                    "param": None,
                    "code": definition["error_code"],
                }
            },
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(int(definition["status"]))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Arforge-Fault-Scenario", scenario)
        self.send_header("Retry-After", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def _forward(self, body: bytes) -> None:
        upstream = self._state.upstream
        headers = {
            name: value
            for name, value in self.headers.items()
            if name.casefold() not in _HOP_BY_HOP
            and name.casefold() not in {"host", "content-length"}
        }
        target = f"{upstream.scheme}://{upstream.netloc}{self.path}"
        try:
            with httpx.Client(timeout=90, follow_redirects=False, trust_env=False) as client:
                response = client.post(target, content=body, headers=headers)
            payload = response.content
            response_status = response.status_code
            response_headers = list(response.headers.multi_items())
        except (OSError, httpx.HTTPError) as exc:
            payload = json.dumps(
                {
                    "error": {
                        "message": "fault proxy upstream transport failed",
                        "type": "proxy_upstream_error",
                        "code": type(exc).__name__,
                    }
                },
                separators=(",", ":"),
            ).encode("utf-8")
            response_status = 502
            response_headers = [("Content-Type", "application/json")]
        self.send_response(response_status)
        for name, value in response_headers:
            if name.casefold() not in _HOP_BY_HOP and name.casefold() != "content-length":
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class ProviderFaultProxy:
    """Loopback reverse proxy that injects one selected transport fault."""

    def __init__(self, upstream_base_url: str):
        self._state = _ProxyState(upstream_base_url.rstrip("/"))
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _FaultProxyHandler)
        self._server.daemon_threads = True
        self._server.arforge_state = self._state  # type: ignore[attr-defined]
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="arforge-provider-fault-proxy",
            daemon=True,
        )
        path = self._state.upstream.path.rstrip("/")
        self.base_url = f"http://127.0.0.1:{self._server.server_port}{path}"

    @property
    def events(self) -> list[dict[str, Any]]:
        with self._state.lock:
            return [event.to_dict() for event in self._state.events]

    @property
    def request_count(self) -> int:
        with self._state.lock:
            return self._state.request_count

    def arm(self, scenario: str, occurrences: int = 1) -> None:
        self._state.arm(scenario, occurrences)

    def pass_through(self) -> None:
        self._state.pass_through()

    def __enter__(self) -> "ProviderFaultProxy":
        self._thread.start()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


def _root_error(exc: BaseException) -> BaseException:
    current = exc
    seen: set[int] = set()
    while id(current) not in seen:
        seen.add(id(current))
        nested = getattr(current, "last_error", None) or current.__cause__
        if not isinstance(nested, BaseException):
            break
        current = nested
    return current


def _fault_detected(scenario: str, exc: BaseException) -> tuple[bool, str, int | None]:
    root = _root_error(exc)
    error_type = type(root).__name__
    status = getattr(root, "status_code", None)
    if not isinstance(status, int):
        response = getattr(root, "response", None)
        status = getattr(response, "status_code", None)
    if scenario == "http_429":
        detected = status == 429 or error_type == "RateLimitError"
    elif scenario == "http_503":
        detected = status == 503 or error_type == "InternalServerError"
    else:
        detected = any(
            marker in error_type.casefold()
            for marker in ("connection", "connect", "protocol", "transport")
        )
    return detected, error_type, status if isinstance(status, int) else None


def run_provider_transport_fault_probe(
    adapter_factory: Callable[[str, int], Any],
    *,
    upstream_base_url: str,
    scenarios: tuple[str, ...] = ("http_429", "http_503", "connection_drop"),
) -> dict[str, Any]:
    """Inject transport faults, reject false success, then recover via upstream."""

    started_at = _utc_now()
    observations: list[dict[str, Any]] = []
    with ProviderFaultProxy(upstream_base_url) as proxy:
        for scenario in scenarios:
            detection_adapter = adapter_factory(proxy.base_url, 0)
            before = len(proxy.events)
            proxy.arm(scenario)
            began = time.monotonic()
            caught: BaseException | None = None
            try:
                detection_adapter.generate_with_tools(
                    [
                        {"role": "system", "content": "Return the exact requested token only."},
                        {"role": "user", "content": "Reply with exactly OK."},
                    ],
                    tools=None,
                    max_tokens=PROVIDER_PROBE_MAX_TOKENS,
                )
            except Exception as exc:  # noqa: BLE001 - the observed class is evidence
                caught = exc
            events = proxy.events[before:]
            detected, error_type, status = (
                _fault_detected(scenario, caught)
                if caught is not None
                else (False, "", None)
            )
            retry_adapter = adapter_factory(proxy.base_url, 1)
            retry_requests_before = proxy.request_count
            proxy.arm(scenario)
            retry_response = retry_adapter.generate_with_tools(
                [
                    {"role": "system", "content": "Return the exact requested token only."},
                    {"role": "user", "content": "Reply with exactly OK."},
                ],
                tools=None,
                max_tokens=PROVIDER_PROBE_MAX_TOKENS,
            )
            retry_requests = proxy.request_count - retry_requests_before
            retry_content_valid = (
                str(getattr(retry_response, "content", "")).strip().casefold()
                == "ok"
            )
            retry_finish_reason = str(
                getattr(retry_response, "finish_reason", "") or ""
            )
            retry_not_truncated = retry_finish_reason.casefold() != "length"
            observations.append(
                {
                    "scenario": scenario,
                    "injection_layer": "loopback_http_tcp_proxy",
                    "proxy_requests": len(events),
                    "request_body_sha256": (
                        events[-1]["request_body_sha256"] if events else ""
                    ),
                    "injected_status_code": _FAULTS[scenario]["status"],
                    "observed_status_code": status,
                    "observed_error_type": error_type,
                    "fault_detected": detected and bool(events),
                    "false_success": caught is None,
                    "retry_proxy_requests": retry_requests,
                    "automatic_retry_recovered": (
                        retry_requests >= 2
                        and retry_content_valid
                        and retry_not_truncated
                    ),
                    "retry_content_valid": retry_content_valid,
                    "retry_finish_reason": retry_finish_reason,
                    "retry_not_truncated": retry_not_truncated,
                    "elapsed_ms": round((time.monotonic() - began) * 1000, 1),
                }
            )

        proxy.pass_through()
        adapter = adapter_factory(proxy.base_url, 0)
        recovery_started = _utc_now()
        response = adapter.generate_with_tools(
            [
                {"role": "system", "content": "Return the exact requested token only."},
                {"role": "user", "content": "Reply with exactly OK."},
            ],
            tools=None,
            max_tokens=PROVIDER_PROBE_MAX_TOKENS,
        )
        recovery_content_valid = str(getattr(response, "content", "")).strip().casefold() == "ok"
        recovery_finish_reason = str(getattr(response, "finish_reason", "") or "")
        recovery_not_truncated = recovery_finish_reason.casefold() != "length"

    all_detected = bool(observations) and all(
        item["fault_detected"]
        and not item["false_success"]
        and item["automatic_retry_recovered"]
        for item in observations
    )
    return {
        "schema_version": 1,
        "injection_layer": "loopback_http_tcp_proxy",
        "started_at_utc": started_at,
        "completed_at_utc": _utc_now(),
        "scenarios": observations,
        "recovery": {
            "started_at_utc": recovery_started,
            "completed_at_utc": _utc_now(),
            "after_all_faults": True,
            "real_provider_request": True,
            "content_valid": recovery_content_valid,
            "finish_reason": recovery_finish_reason,
            "not_truncated": recovery_not_truncated,
        },
        "passed": all_detected and recovery_content_valid and recovery_not_truncated,
    }
