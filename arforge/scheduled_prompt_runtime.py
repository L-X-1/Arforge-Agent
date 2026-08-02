"""Persistent, session-owned scheduling for future agent prompts."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterator

from arforge.paths import data_path
from arforge.security_guard import sanitize_for_storage


SCHEMA_VERSION = 1
MAX_JOBS = 50
MAX_PROMPT_CHARS = 20_000
MAX_NAME_CHARS = 120
MAX_STATE_BYTES = 4 * 1024 * 1024
RECURRING_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
RETRY_DELAY_SECONDS = 15
LOCK_TIMEOUT_SECONDS = 5.0
STALE_LOCK_SECONDS = 120.0
OWNER_STALE_SECONDS = 15.0
CHECK_INTERVAL_SECONDS = 1.0


def _process_is_alive(pid: int) -> bool:
    """Return whether *pid* still owns a live process without extra packages."""
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        import ctypes

        process_query_limited_information = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(  # type: ignore[attr-defined]
            process_query_limited_information,
            False,
            pid,
        )
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)  # type: ignore[attr-defined]
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True

_FIELD_RANGES = (
    (0, 59),
    (0, 23),
    (1, 31),
    (1, 12),
    (0, 6),
)


class ScheduledPromptError(ValueError):
    """Raised when scheduled prompt state or input is invalid."""


@dataclass(frozen=True)
class CronFields:
    minute: frozenset[int]
    hour: frozenset[int]
    day_of_month: frozenset[int]
    month: frozenset[int]
    day_of_week: frozenset[int]


def _expand_field(value: str, minimum: int, maximum: int) -> frozenset[int] | None:
    result: set[int] = set()
    is_day_of_week = minimum == 0 and maximum == 6
    for part in value.split(","):
        wildcard = re.fullmatch(r"\*(?:/(\d+))?", part)
        if wildcard:
            step = int(wildcard.group(1) or "1")
            if step < 1:
                return None
            result.update(range(minimum, maximum + 1, step))
            continue

        ranged = re.fullmatch(r"(\d+)-(\d+)(?:/(\d+))?", part)
        if ranged:
            low = int(ranged.group(1))
            high = int(ranged.group(2))
            step = int(ranged.group(3) or "1")
            effective_maximum = 7 if is_day_of_week else maximum
            if low > high or step < 1 or low < minimum or high > effective_maximum:
                return None
            for item in range(low, high + 1, step):
                result.add(0 if is_day_of_week and item == 7 else item)
            continue

        if re.fullmatch(r"\d+", part):
            item = int(part)
            if is_day_of_week and item == 7:
                item = 0
            if item < minimum or item > maximum:
                return None
            result.add(item)
            continue
        return None
    return frozenset(result) if result else None


def parse_cron(expression: str) -> CronFields | None:
    """Parse the supported standard five-field cron subset."""
    if not isinstance(expression, str):
        return None
    parts = expression.strip().split()
    if len(parts) != 5:
        return None
    expanded = [
        _expand_field(value, minimum, maximum)
        for value, (minimum, maximum) in zip(parts, _FIELD_RANGES, strict=True)
    ]
    if any(item is None for item in expanded):
        return None
    return CronFields(
        minute=expanded[0] or frozenset(),
        hour=expanded[1] or frozenset(),
        day_of_month=expanded[2] or frozenset(),
        month=expanded[3] or frozenset(),
        day_of_week=expanded[4] or frozenset(),
    )


def next_cron_run(expression: str, from_timestamp: float) -> float | None:
    """Return the next local-time cron match strictly after the timestamp."""
    fields = parse_cron(expression)
    if fields is None:
        return None
    candidate = (int(from_timestamp) // 60 + 1) * 60
    day_of_month_wildcard = len(fields.day_of_month) == 31
    day_of_week_wildcard = len(fields.day_of_week) == 7
    for _ in range(366 * 24 * 60):
        local = datetime.fromtimestamp(candidate)
        day_of_week = (local.weekday() + 1) % 7
        if day_of_month_wildcard and day_of_week_wildcard:
            day_matches = True
        elif day_of_month_wildcard:
            day_matches = day_of_week in fields.day_of_week
        elif day_of_week_wildcard:
            day_matches = local.day in fields.day_of_month
        else:
            day_matches = (
                local.day in fields.day_of_month
                or day_of_week in fields.day_of_week
            )
        if (
            local.month in fields.month
            and day_matches
            and local.hour in fields.hour
            and local.minute in fields.minute
        ):
            return float(candidate)
        candidate += 60
    return None


def cron_to_human(expression: str) -> str:
    """Render common schedules compactly and preserve uncommon expressions."""
    parts = expression.strip().split()
    if len(parts) != 5:
        return expression
    minute, hour, day_of_month, month, day_of_week = parts
    if minute.startswith("*/") and parts[1:] == ["*", "*", "*", "*"]:
        interval = int(minute[2:])
        return "Every minute" if interval == 1 else f"Every {interval} minutes"
    if minute.isdigit() and hour == "*" and parts[2:] == ["*", "*", "*"]:
        return "Every hour" if minute == "0" else f"Every hour at :{int(minute):02d}"
    if minute.isdigit() and hour.isdigit():
        clock = f"{int(hour):02d}:{int(minute):02d}"
        if day_of_month == month == day_of_week == "*":
            return f"Every day at {clock}"
        if day_of_month == "*" and month == "*" and day_of_week == "1-5":
            return f"Weekdays at {clock}"
    return expression


def _jitter_fraction(job_id: str) -> float:
    digest = hashlib.sha256(job_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 2**32


def _next_fire(expression: str, anchor: float, job_id: str, recurring: bool) -> float | None:
    first = next_cron_run(expression, anchor)
    if first is None:
        return None
    fraction = _jitter_fraction(job_id)
    if recurring:
        second = next_cron_run(expression, first)
        if second is None:
            return first
        return first + min(fraction * 0.1 * (second - first), 15 * 60)
    if datetime.fromtimestamp(first).minute % 30 == 0:
        return max(first - fraction * 90, anchor)
    return first


def _clean_prompt(value: Any) -> str:
    if not isinstance(value, str):
        raise ScheduledPromptError("prompt must be a string")
    prompt = str(sanitize_for_storage(value)).strip()
    if not prompt:
        raise ScheduledPromptError("prompt must not be empty")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ScheduledPromptError(
            f"prompt must be at most {MAX_PROMPT_CHARS} characters"
        )
    return prompt


def _clean_name(value: Any, *, fallback: str = "") -> str:
    if value is None or value == "":
        return fallback
    if not isinstance(value, str):
        raise ScheduledPromptError("name must be a string")
    name = " ".join(str(sanitize_for_storage(value)).split())
    if not name:
        raise ScheduledPromptError("name must not be empty")
    if len(name) > MAX_NAME_CHARS:
        raise ScheduledPromptError(f"name must be at most {MAX_NAME_CHARS} characters")
    return name


class ScheduledPromptManager:
    """Durable store and single-owner background dispatcher."""

    def __init__(
        self,
        state_path: str | Path | None = None,
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.state_path = Path(
            state_path or data_path("scheduled_prompts.json")
        ).expanduser().resolve()
        self.lock_path = self.state_path.with_suffix(self.state_path.suffix + ".lock")
        self.owner_path = self.state_path.with_suffix(self.state_path.suffix + ".owner")
        self._clock = clock
        self._memory_jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._owner_token = uuid.uuid4().hex
        self._owns_durable_dispatch = False
        self._on_fire: Callable[[dict[str, Any]], bool] | None = None
        self._on_event: Callable[[dict[str, Any]], None] | None = None

    @contextmanager
    def _state_lock(self) -> Iterator[None]:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
        descriptor: int | None = None
        while descriptor is None:
            try:
                descriptor = os.open(
                    self.lock_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
                os.write(descriptor, f"{os.getpid()} {self._clock()}\n".encode("ascii"))
                os.fsync(descriptor)
            except FileExistsError:
                try:
                    owner_pid = 0
                    try:
                        owner_pid = int(
                            self.lock_path.read_text(encoding="ascii").split(maxsplit=1)[0]
                        )
                    except (OSError, UnicodeError, ValueError, IndexError):
                        pass
                    owner_exited = owner_pid > 0 and not _process_is_alive(owner_pid)
                    expired = self._clock() - self.lock_path.stat().st_mtime > STALE_LOCK_SECONDS
                    if owner_exited or expired:
                        self.lock_path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    raise ScheduledPromptError(
                        "timed out waiting for scheduled prompt state lock"
                    )
                time.sleep(0.02)
        try:
            yield
        finally:
            if descriptor is not None:
                os.close(descriptor)
            self.lock_path.unlink(missing_ok=True)

    def _load_unlocked(self) -> list[dict[str, Any]]:
        try:
            if self.state_path.stat().st_size > MAX_STATE_BYTES:
                raise ScheduledPromptError("scheduled prompt state is too large")
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except ScheduledPromptError:
            raise
        except (OSError, json.JSONDecodeError) as exc:
            raise ScheduledPromptError("scheduled prompt state is unreadable") from exc
        if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
            raise ScheduledPromptError("unsupported scheduled prompt state schema")
        jobs = payload.get("jobs")
        if not isinstance(jobs, list):
            raise ScheduledPromptError("scheduled prompt jobs must be a list")
        return [self._normalize_job(job, durable=True) for job in jobs]

    def _save_unlocked(self, jobs: list[dict[str, Any]]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": SCHEMA_VERSION,
            "jobs": [self._storage_job(job) for job in jobs],
        }
        rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        temporary = ""
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                delete=False,
                dir=str(self.state_path.parent),
            ) as stream:
                stream.write(rendered)
                stream.flush()
                os.fsync(stream.fileno())
                temporary = stream.name
            os.replace(temporary, self.state_path)
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)

    @staticmethod
    def _storage_job(job: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value
            for key, value in job.items()
            if key not in {"durable", "human_schedule"}
        }

    @staticmethod
    def _normalize_job(raw: Any, *, durable: bool) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ScheduledPromptError("scheduled prompt state contains a non-object")
        job_id = str(raw.get("id", "")).strip()
        session_id = str(raw.get("session_id", "")).strip()
        expression = str(raw.get("cron", "")).strip()
        if not job_id or not session_id or parse_cron(expression) is None:
            raise ScheduledPromptError("scheduled prompt state contains an invalid job")
        recurring = bool(raw.get("recurring", True))
        status = str(raw.get("status", "pending"))
        if status not in {"pending", "dispatching", "missed"}:
            raise ScheduledPromptError("scheduled prompt state contains an invalid status")
        try:
            created_at = float(raw["created_at"])
            next_fire_at = float(raw["next_fire_at"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ScheduledPromptError(
                "scheduled prompt state contains invalid timestamps"
            ) from exc
        last_fired_at = raw.get("last_fired_at")
        return {
            "id": job_id,
            "name": _clean_name(raw.get("name"), fallback=f"Scheduled prompt {job_id}"),
            "session_id": session_id,
            "project_id": str(raw.get("project_id", "default")),
            "cron": expression,
            "prompt": _clean_prompt(raw.get("prompt", "")),
            "recurring": recurring,
            "enabled": bool(raw.get("enabled", True)),
            "durable": durable,
            "status": status,
            "created_at": created_at,
            "last_fired_at": (
                float(last_fired_at) if last_fired_at is not None else None
            ),
            "next_fire_at": next_fire_at,
            "dispatch_started_at": (
                float(raw["dispatch_started_at"])
                if raw.get("dispatch_started_at") is not None
                else None
            ),
        }

    @staticmethod
    def _public_job(job: dict[str, Any]) -> dict[str, Any]:
        return {
            **job,
            "human_schedule": cron_to_human(job["cron"]),
            "created_at_iso": datetime.fromtimestamp(job["created_at"]).astimezone().isoformat(),
            "next_fire_at_iso": datetime.fromtimestamp(job["next_fire_at"]).astimezone().isoformat(),
            "last_fired_at_iso": (
                datetime.fromtimestamp(job["last_fired_at"]).astimezone().isoformat()
                if job["last_fired_at"] is not None
                else None
            ),
        }

    def create(
        self,
        session_id: str,
        cron: str,
        prompt: str,
        *,
        recurring: bool = True,
        durable: bool = False,
        project_id: str = "default",
        name: str = "",
        enabled: bool = True,
    ) -> dict[str, Any]:
        session = str(session_id or "").strip()
        if not session:
            raise ScheduledPromptError("session_id must be a non-empty string")
        expression = str(cron or "").strip()
        if parse_cron(expression) is None:
            raise ScheduledPromptError(
                "cron must use five fields: minute hour day-of-month month day-of-week"
            )
        clean_prompt = _clean_prompt(prompt)
        if (
            not isinstance(recurring, bool)
            or not isinstance(durable, bool)
            or not isinstance(enabled, bool)
        ):
            raise ScheduledPromptError("recurring, durable, and enabled must be booleans")
        now = self._clock()
        job_id = uuid.uuid4().hex[:8]
        next_fire_at = _next_fire(expression, now, job_id, bool(recurring))
        if next_fire_at is None:
            raise ScheduledPromptError("cron has no matching date in the next year")
        job = {
            "id": job_id,
            "name": _clean_name(name, fallback=f"Scheduled prompt {job_id}"),
            "session_id": session,
            "project_id": str(project_id or "default"),
            "cron": expression,
            "prompt": clean_prompt,
            "recurring": recurring,
            "enabled": enabled,
            "durable": durable,
            "status": "pending",
            "created_at": now,
            "last_fired_at": None,
            "next_fire_at": next_fire_at,
            "dispatch_started_at": None,
        }
        with self._lock:
            with self._state_lock():
                durable_jobs = self._load_unlocked()
                if len(durable_jobs) + len(self._memory_jobs) >= MAX_JOBS:
                    raise ScheduledPromptError(
                        f"too many scheduled prompts; maximum is {MAX_JOBS}"
                    )
                if durable:
                    durable_jobs.append(job)
                    self._save_unlocked(durable_jobs)
                else:
                    self._memory_jobs[job_id] = job
        self._emit("schedule.created", self._public_job(job))
        return self._public_job(job)

    def list(
        self,
        session_id: str | None = None,
        *,
        include_all_sessions: bool = False,
    ) -> list[dict[str, Any]]:
        with self._lock, self._state_lock():
            jobs = self._load_unlocked() + list(self._memory_jobs.values())
        if not include_all_sessions:
            session = str(session_id or "").strip()
            if not session:
                raise ScheduledPromptError("session_id must be a non-empty string")
            jobs = [job for job in jobs if job["session_id"] == session]
        jobs.sort(key=lambda job: (job["next_fire_at"], job["id"]))
        return [self._public_job(job) for job in jobs]

    def get(self, session_id: str, job_id: str) -> dict[str, Any]:
        session = str(session_id or "").strip()
        identifier = str(job_id or "").strip()
        if not session or not identifier:
            raise ScheduledPromptError("session_id and job_id must be non-empty strings")
        with self._lock, self._state_lock():
            jobs = self._load_unlocked()
            job = self._memory_jobs.get(identifier) or next(
                (item for item in jobs if item["id"] == identifier),
                None,
            )
        if job is None:
            raise ScheduledPromptError("scheduled prompt not found")
        self._assert_owner(session, job)
        return self._public_job(job)

    def update(
        self,
        session_id: str,
        job_id: str,
        changes: dict[str, Any],
    ) -> dict[str, Any]:
        session = str(session_id or "").strip()
        identifier = str(job_id or "").strip()
        if not session or not identifier:
            raise ScheduledPromptError("session_id and job_id must be non-empty strings")
        if not isinstance(changes, dict) or not changes:
            raise ScheduledPromptError("changes must be a non-empty object")
        allowed = {"name", "cron", "cron_expression", "prompt", "recurring", "enabled"}
        unexpected = sorted(set(changes) - allowed)
        if unexpected:
            raise ScheduledPromptError(
                f"unsupported schedule fields: {', '.join(unexpected)}"
            )
        if "cron" in changes and "cron_expression" in changes:
            raise ScheduledPromptError("provide only one of cron or cron_expression")
        now = self._clock()
        with self._lock, self._state_lock():
            durable_jobs = self._load_unlocked()
            memory_job = self._memory_jobs.get(identifier)
            job = memory_job or next(
                (item for item in durable_jobs if item["id"] == identifier),
                None,
            )
            if job is None:
                raise ScheduledPromptError("scheduled prompt not found")
            self._assert_owner(session, job)
            if "name" in changes:
                job["name"] = _clean_name(changes["name"])
            if "prompt" in changes:
                job["prompt"] = _clean_prompt(changes["prompt"])
            for key in ("recurring", "enabled"):
                if key in changes:
                    if not isinstance(changes[key], bool):
                        raise ScheduledPromptError(f"{key} must be a boolean")
                    job[key] = changes[key]
            expression = changes.get("cron_expression", changes.get("cron"))
            if expression is not None:
                expression = str(expression or "").strip()
                if parse_cron(expression) is None:
                    raise ScheduledPromptError(
                        "cron must use five fields: minute hour day-of-month month day-of-week"
                    )
                job["cron"] = expression
            if expression is not None or "recurring" in changes or (
                changes.get("enabled") is True
            ):
                next_fire_at = _next_fire(
                    job["cron"],
                    now,
                    job["id"],
                    bool(job["recurring"]),
                )
                if next_fire_at is None:
                    raise ScheduledPromptError("cron has no matching date in the next year")
                job["next_fire_at"] = next_fire_at
                if job["status"] != "missed":
                    job["status"] = "pending"
                    job["dispatch_started_at"] = None
            if memory_job is None:
                self._save_unlocked(durable_jobs)
        public = self._public_job(job)
        self._emit("schedule.updated", public)
        return public

    def run_now(self, session_id: str, job_id: str) -> dict[str, Any]:
        job = self.get(session_id, job_id)
        self._emit("schedule.run_requested", job)
        return job

    def delete(self, session_id: str, job_id: str) -> dict[str, Any]:
        session = str(session_id or "").strip()
        identifier = str(job_id or "").strip()
        if not session or not identifier:
            raise ScheduledPromptError("session_id and job_id must be non-empty strings")
        with self._lock, self._state_lock():
            memory = self._memory_jobs.get(identifier)
            if memory is not None:
                self._assert_owner(session, memory)
                removed = self._memory_jobs.pop(identifier)
            else:
                jobs = self._load_unlocked()
                match = next((job for job in jobs if job["id"] == identifier), None)
                if match is None:
                    raise ScheduledPromptError("scheduled prompt not found")
                self._assert_owner(session, match)
                removed = match
                self._save_unlocked([job for job in jobs if job["id"] != identifier])
        public = self._public_job(removed)
        self._emit("schedule.deleted", public)
        return public

    def consume_for_current_turn(self, session_id: str, job_id: str) -> dict[str, Any]:
        """Consume a missed job so its prompt can run in the current agent turn."""
        session = str(session_id or "").strip()
        identifier = str(job_id or "").strip()
        if not session or not identifier:
            raise ScheduledPromptError("session_id and job_id must be non-empty strings")
        now = self._clock()
        with self._lock, self._state_lock():
            jobs = self._load_unlocked()
            memory = self._memory_jobs.get(identifier)
            job = memory or next((item for item in jobs if item["id"] == identifier), None)
            if job is None:
                raise ScheduledPromptError("scheduled prompt not found")
            self._assert_owner(session, job)
            if job["status"] != "missed":
                raise ScheduledPromptError("only a missed scheduled prompt can be run manually")
            if job["recurring"]:
                self._reschedule(job, now)
            elif memory is not None:
                self._memory_jobs.pop(identifier, None)
            else:
                jobs = [item for item in jobs if item["id"] != identifier]
            if memory is None:
                self._save_unlocked(jobs)
        public = self._public_job(job)
        self._emit("schedule.consumed", public)
        return public

    @staticmethod
    def _assert_owner(session_id: str, job: dict[str, Any]) -> None:
        if job["session_id"] != session_id:
            raise ScheduledPromptError("scheduled prompt is owned by another session")

    def start(
        self,
        on_fire: Callable[[dict[str, Any]], bool],
        *,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        if not callable(on_fire):
            raise ScheduledPromptError("on_fire must be callable")
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._on_fire = on_fire
            self._on_event = on_event
            self._stop.clear()
            self._acquire_owner()
            self._prepare_startup()
            self._thread = threading.Thread(
                target=self._run_loop,
                daemon=True,
                name="arforge-scheduled-prompts",
            )
            self._thread.start()

    def stop(self, timeout: float = 3.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout)
        self._release_owner()

    def _prepare_startup(self) -> None:
        if not self._owns_durable_dispatch:
            return
        now = self._clock()
        with self._state_lock():
            jobs = self._load_unlocked()
            changed = False
            for job in jobs:
                if job["status"] == "dispatching":
                    job["status"] = "pending" if job["recurring"] else "missed"
                    job["dispatch_started_at"] = None
                    changed = True
                if (
                    job["enabled"]
                    and
                    not job["recurring"]
                    and job["status"] == "pending"
                    and job["next_fire_at"] <= now
                ):
                    job["status"] = "missed"
                    changed = True
                    self._emit("schedule.missed", self._public_job(job))
            if changed:
                self._save_unlocked(jobs)

    def _run_loop(self) -> None:
        while not self._stop.wait(CHECK_INTERVAL_SECONDS):
            try:
                self._heartbeat_owner()
                self._tick()
            except Exception as exc:  # noqa: BLE001 - scheduler must survive bad state/callbacks
                self._emit(
                    "schedule.error",
                    {"message": str(exc.__class__.__name__) + ": " + str(exc)},
                )

    def _tick(self) -> None:
        now = self._clock()
        claimed: list[dict[str, Any]] = []
        with self._lock:
            for job in self._memory_jobs.values():
                if (
                    job["enabled"]
                    and job["status"] == "pending"
                    and job["next_fire_at"] <= now
                ):
                    job["status"] = "dispatching"
                    job["dispatch_started_at"] = now
                    claimed.append(dict(job))
            if self._owns_durable_dispatch:
                with self._state_lock():
                    jobs = self._load_unlocked()
                    changed = False
                    for job in jobs:
                        if (
                            job["enabled"]
                            and job["status"] == "pending"
                            and job["next_fire_at"] <= now
                        ):
                            job["status"] = "dispatching"
                            job["dispatch_started_at"] = now
                            claimed.append(dict(job))
                            changed = True
                    if changed:
                        self._save_unlocked(jobs)
        for job in claimed:
            accepted = False
            try:
                accepted = bool(self._on_fire and self._on_fire(self._public_job(job)))
            except Exception:  # noqa: BLE001 - callback failure is retried
                accepted = False
            self._finalize_dispatch(job, accepted)

    def _finalize_dispatch(self, claimed: dict[str, Any], accepted: bool) -> None:
        now = self._clock()
        with self._lock, self._state_lock():
            durable_jobs = self._load_unlocked()
            memory_job = self._memory_jobs.get(claimed["id"])
            job = memory_job or next(
                (item for item in durable_jobs if item["id"] == claimed["id"]),
                None,
            )
            if job is None or job["status"] != "dispatching":
                return
            if not accepted:
                job["status"] = "pending"
                job["dispatch_started_at"] = None
                job["next_fire_at"] = now + RETRY_DELAY_SECONDS
            elif job["recurring"]:
                expired = now - job["created_at"] >= RECURRING_MAX_AGE_SECONDS
                if expired:
                    if memory_job is not None:
                        self._memory_jobs.pop(job["id"], None)
                    else:
                        durable_jobs = [
                            item for item in durable_jobs if item["id"] != job["id"]
                        ]
                else:
                    self._reschedule(job, now)
            elif memory_job is not None:
                self._memory_jobs.pop(job["id"], None)
            else:
                durable_jobs = [
                    item for item in durable_jobs if item["id"] != job["id"]
                ]
            if memory_job is None:
                self._save_unlocked(durable_jobs)
        self._emit(
            "schedule.dispatched" if accepted else "schedule.deferred",
            {**self._public_job(job), "accepted": accepted},
        )

    @staticmethod
    def _reschedule(job: dict[str, Any], now: float) -> None:
        next_fire_at = _next_fire(job["cron"], now, job["id"], True)
        if next_fire_at is None:
            raise ScheduledPromptError("recurring cron no longer has a valid next run")
        job["status"] = "pending"
        job["last_fired_at"] = now
        job["next_fire_at"] = next_fire_at
        job["dispatch_started_at"] = None

    def _acquire_owner(self) -> None:
        self.owner_path.parent.mkdir(parents=True, exist_ok=True)
        with self._state_lock():
            try:
                current = self.owner_path.read_text(encoding="ascii").split()
                timestamp = float(current[1]) if len(current) >= 2 else 0.0
            except (FileNotFoundError, OSError, ValueError):
                current = []
                timestamp = 0.0
            if current and self._clock() - timestamp <= OWNER_STALE_SECONDS:
                self._owns_durable_dispatch = current[0] == self._owner_token
                return
            self.owner_path.unlink(missing_ok=True)
            descriptor: int | None = None
            try:
                descriptor = os.open(
                    self.owner_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
                os.write(
                    descriptor,
                    f"{self._owner_token} {self._clock()}\n".encode("ascii"),
                )
                os.fsync(descriptor)
                self._owns_durable_dispatch = True
            except FileExistsError:
                self._owns_durable_dispatch = False
            finally:
                if descriptor is not None:
                    os.close(descriptor)

    def _heartbeat_owner(self) -> None:
        if not self._owns_durable_dispatch:
            self._acquire_owner()
            return
        with self._state_lock():
            try:
                current = self.owner_path.read_text(encoding="ascii").split()
            except OSError:
                current = []
            if not current or current[0] != self._owner_token:
                self._owns_durable_dispatch = False
                return
            self.owner_path.write_text(
                f"{self._owner_token} {self._clock()}\n",
                encoding="ascii",
            )

    def _release_owner(self) -> None:
        if not self._owns_durable_dispatch:
            return
        try:
            current = self.owner_path.read_text(encoding="ascii").split()
            if current and current[0] == self._owner_token:
                self.owner_path.unlink(missing_ok=True)
        except OSError:
            pass
        self._owns_durable_dispatch = False

    def _emit(self, event_type: str, data: dict[str, Any]) -> None:
        callback = self._on_event
        if callback is None:
            return
        try:
            callback(
                {
                    "type": event_type,
                    "timestamp": datetime.now().astimezone().isoformat(),
                    "data": data,
                }
            )
        except Exception:  # noqa: BLE001 - observability cannot stop scheduling
            pass


_MANAGER_LOCK = threading.RLock()
_MANAGER: ScheduledPromptManager | None = None


def get_scheduled_prompt_manager() -> ScheduledPromptManager:
    global _MANAGER
    with _MANAGER_LOCK:
        expected = data_path("scheduled_prompts.json").expanduser().resolve()
        if _MANAGER is None or _MANAGER.state_path != expected:
            if _MANAGER is not None:
                _MANAGER.stop()
            _MANAGER = ScheduledPromptManager(expected)
        return _MANAGER


def reset_scheduled_prompt_manager() -> None:
    """Reset the process singleton for isolated tests and profile switches."""
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is not None:
            _MANAGER.stop()
        _MANAGER = None


__all__ = [
    "CronFields",
    "MAX_JOBS",
    "ScheduledPromptError",
    "ScheduledPromptManager",
    "cron_to_human",
    "get_scheduled_prompt_manager",
    "next_cron_run",
    "parse_cron",
    "reset_scheduled_prompt_manager",
]
