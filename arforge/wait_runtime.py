"""Interruptible cooperative waits with periodic Bridge check-ins."""

from __future__ import annotations

import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterator


MIN_WAIT_SECONDS = 0.05
MAX_WAIT_SECONDS = 300.0
MIN_CHECK_IN_SECONDS = 0.05
MAX_CHECK_IN_SECONDS = 60.0
MAX_CHECK_INS = 120
MAX_REASON_CHARS = 200
POLL_SECONDS = 0.05


class WaitRuntimeError(ValueError):
    """Raised when a cooperative wait violates its runtime contract."""


@dataclass
class WaitScopeState:
    manager: "WaitManager"
    cancel_event: threading.Event | None = None
    deadline_monotonic: float | None = None
    on_event: Callable[[str, dict[str, Any]], None] | None = None


@dataclass
class ActiveWait:
    wait_id: str
    session_id: str
    reason: str
    duration_seconds: float
    check_in_interval: float
    started_monotonic: float
    started_at: str
    wake_event: threading.Event
    check_in_count: int = 0

    def public(self, *, now: float | None = None) -> dict[str, Any]:
        current = time.monotonic() if now is None else now
        elapsed = max(0.0, current - self.started_monotonic)
        return {
            "wait_id": self.wait_id,
            "session_id": self.session_id,
            "reason": self.reason,
            "duration_seconds": self.duration_seconds,
            "check_in_interval": self.check_in_interval,
            "started_at": self.started_at,
            "elapsed_seconds": round(elapsed, 3),
            "remaining_seconds": round(max(0.0, self.duration_seconds - elapsed), 3),
            "check_in_count": self.check_in_count,
        }


_WAIT_SCOPE: ContextVar[WaitScopeState | None] = ContextVar(
    "arforge_wait_scope",
    default=None,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _clean_reason(value: Any) -> str:
    if not isinstance(value, str):
        raise WaitRuntimeError("reason must be a string")
    reason = " ".join(value.split())
    if len(reason) > MAX_REASON_CHARS:
        raise WaitRuntimeError(f"reason must be at most {MAX_REASON_CHARS} characters")
    return reason


class WaitManager:
    """Track one interruptible cooperative wait per session."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._active: dict[str, ActiveWait] = {}
        self._lock = threading.RLock()
        self._changed = threading.Condition(self._lock)

    def active(self, session_id: str) -> dict[str, Any] | None:
        session = str(session_id or "").strip()
        if not session:
            raise WaitRuntimeError("session_id must be a non-empty string")
        with self._lock:
            record = self._active.get(session)
            return record.public(now=self._clock()) if record is not None else None

    def wake(self, session_id: str, wait_id: str = "") -> dict[str, Any]:
        session = str(session_id or "").strip()
        identifier = str(wait_id or "").strip()
        if not session:
            raise WaitRuntimeError("session_id must be a non-empty string")
        with self._lock:
            record = self._active.get(session)
            if record is None:
                raise WaitRuntimeError("no active wait for session")
            if identifier and identifier != record.wait_id:
                raise WaitRuntimeError("active wait identifier does not match")
            public = record.public(now=self._clock())
            record.wake_event.set()
            return {**public, "wake_requested": True}

    def wake_and_wait(
        self,
        session_id: str,
        wait_id: str = "",
        *,
        timeout: float = 0.25,
    ) -> bool:
        """Wake an active wait and briefly await its registry cleanup.

        Cancellation callers use this stronger form so an operation cannot be
        externally terminal while its cooperative wait is still advertised as
        active.  The bounded wait is confined to cancellation/timeout paths.
        """

        session = str(session_id or "").strip()
        identifier = str(wait_id or "").strip()
        if not session:
            raise WaitRuntimeError("session_id must be a non-empty string")
        try:
            bounded_timeout = max(0.0, float(timeout))
        except (TypeError, ValueError):
            raise WaitRuntimeError("timeout must be a number") from None
        with self._changed:
            record = self._active.get(session)
            if record is None:
                return True
            if identifier and identifier != record.wait_id:
                raise WaitRuntimeError("active wait identifier does not match")
            record.wake_event.set()
            return self._changed.wait_for(
                lambda: self._active.get(session) is not record,
                timeout=bounded_timeout,
            )

    def wait(
        self,
        session_id: str,
        duration_seconds: float,
        *,
        check_in_interval: float = 30.0,
        reason: str = "",
        cancel_event: threading.Event | None = None,
        deadline_monotonic: float | None = None,
        on_event: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        session = str(session_id or "").strip()
        if not session:
            raise WaitRuntimeError("session_id must be a non-empty string")
        try:
            duration = float(duration_seconds)
            interval = float(check_in_interval)
        except (TypeError, ValueError):
            raise WaitRuntimeError("wait duration and check-in interval must be numbers") from None
        if not MIN_WAIT_SECONDS <= duration <= MAX_WAIT_SECONDS:
            raise WaitRuntimeError(
                f"duration_seconds must be between {MIN_WAIT_SECONDS} and {MAX_WAIT_SECONDS}"
            )
        if not MIN_CHECK_IN_SECONDS <= interval <= MAX_CHECK_IN_SECONDS:
            raise WaitRuntimeError(
                f"check_in_interval must be between {MIN_CHECK_IN_SECONDS} and {MAX_CHECK_IN_SECONDS}"
            )
        if duration / interval > MAX_CHECK_INS:
            raise WaitRuntimeError(
                f"wait would exceed the maximum of {MAX_CHECK_INS} check-ins"
            )
        clean_reason = _clean_reason(reason)
        started = self._clock()
        record = ActiveWait(
            wait_id=uuid.uuid4().hex[:12],
            session_id=session,
            reason=clean_reason,
            duration_seconds=duration,
            check_in_interval=interval,
            started_monotonic=started,
            started_at=_utc_now(),
            wake_event=threading.Event(),
        )
        with self._lock:
            if session in self._active:
                raise WaitRuntimeError("session already has an active wait")
            self._active[session] = record
        self._emit(on_event, "wait.started", record.public(now=started))
        status = "completed"
        next_check_in = started + interval
        try:
            while True:
                now = self._clock()
                if cancel_event is not None and cancel_event.is_set():
                    status = "cancelled"
                    break
                if deadline_monotonic is not None and now >= deadline_monotonic:
                    status = "timed_out"
                    break
                if record.wake_event.is_set():
                    status = "woken"
                    break
                if now - started >= duration:
                    status = "completed"
                    break
                if now >= next_check_in:
                    record.check_in_count += 1
                    self._emit(
                        on_event,
                        "wait.check_in",
                        record.public(now=now),
                    )
                    next_check_in = now + interval
                remaining = max(0.0, duration - (now - started))
                until_check_in = max(0.0, next_check_in - now)
                timeout = min(POLL_SECONDS, remaining, until_check_in)
                if deadline_monotonic is not None:
                    timeout = min(timeout, max(0.0, deadline_monotonic - now))
                record.wake_event.wait(max(0.001, timeout))
        finally:
            finished = self._clock()
            with self._changed:
                if self._active.get(session) is record:
                    self._active.pop(session, None)
                    self._changed.notify_all()
        result = {
            **record.public(now=finished),
            "status": status,
            "finished_at": _utc_now(),
        }
        self._emit(on_event, f"wait.{status}", result)
        return result

    @staticmethod
    def _emit(
        callback: Callable[[str, dict[str, Any]], None] | None,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        if callback is not None:
            try:
                callback(event_type, dict(data))
            except Exception:  # noqa: BLE001 - observers must not break the wait
                return


_GLOBAL_MANAGER = WaitManager()


def get_wait_manager() -> WaitManager:
    return _GLOBAL_MANAGER


@contextmanager
def wait_scope(
    *,
    manager: WaitManager | None = None,
    cancel_event: threading.Event | None = None,
    deadline_monotonic: float | None = None,
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
) -> Iterator[WaitScopeState]:
    state = WaitScopeState(
        manager=manager or get_wait_manager(),
        cancel_event=cancel_event,
        deadline_monotonic=deadline_monotonic,
        on_event=on_event,
    )
    token = _WAIT_SCOPE.set(state)
    try:
        yield state
    finally:
        _WAIT_SCOPE.reset(token)


def cooperative_wait(
    session_id: str,
    duration_seconds: float,
    *,
    check_in_interval: float = 30.0,
    reason: str = "",
) -> dict[str, Any]:
    state = _WAIT_SCOPE.get()
    manager = state.manager if state is not None else get_wait_manager()
    return manager.wait(
        session_id,
        duration_seconds,
        check_in_interval=check_in_interval,
        reason=reason,
        cancel_event=state.cancel_event if state is not None else None,
        deadline_monotonic=state.deadline_monotonic if state is not None else None,
        on_event=state.on_event if state is not None else None,
    )


__all__ = [
    "MAX_WAIT_SECONDS",
    "WaitManager",
    "WaitRuntimeError",
    "cooperative_wait",
    "get_wait_manager",
    "wait_scope",
]
