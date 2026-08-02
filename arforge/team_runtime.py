"""Durable, session-owned team metadata and mailbox runtime."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from arforge.paths import data_path
from arforge.security_guard import sanitize_for_storage


SCHEMA_VERSION = 1
MAX_MEMBERS = 8
MAX_MESSAGES = 500
MAX_MESSAGE_CHARS = 8_000
MAX_SUMMARY_CHARS = 160
MAX_DESCRIPTION_CHARS = 1_000
MAX_STATE_BYTES = 4 * 1024 * 1024
LOCK_TIMEOUT_SECONDS = 5.0
STALE_LOCK_SECONDS = 120.0
_SAFE_MEMBER_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
_MESSAGE_KINDS = {"info", "request", "result", "alert"}


class TeamRuntimeError(ValueError):
    """Stable error returned by team lifecycle operations."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _now_iso(clock: Callable[[], float]) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(clock(), timezone.utc).isoformat()


def _clean_text(
    value: Any,
    field: str,
    *,
    maximum: int,
    required: bool = True,
) -> str:
    if not isinstance(value, str):
        raise TeamRuntimeError("INVALID_PARAMS", f"{field} must be a string")
    cleaned = str(sanitize_for_storage(value)).strip()
    if required and not cleaned:
        raise TeamRuntimeError("INVALID_PARAMS", f"{field} must not be empty")
    if any(ord(char) < 32 and char not in "\t\n\r" for char in cleaned):
        raise TeamRuntimeError("INVALID_PARAMS", f"{field} contains control characters")
    if len(cleaned) > maximum:
        raise TeamRuntimeError(
            "INVALID_PARAMS",
            f"{field} must be at most {maximum} characters",
        )
    return cleaned


def _clean_member_name(value: Any) -> str:
    name = _clean_text(value, "member_name", maximum=32)
    if not _SAFE_MEMBER_NAME.fullmatch(name):
        raise TeamRuntimeError(
            "INVALID_PARAMS",
            "member_name must start with a letter and contain only letters, digits, _ or -",
        )
    if name.casefold() == "lead":
        raise TeamRuntimeError("INVALID_PARAMS", "lead is a reserved member name")
    return name


class TeamManager:
    """Atomic team store keyed only by the owning lead session."""

    def __init__(
        self,
        state_path: str | Path | None = None,
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.state_path = Path(
            state_path or data_path("teams.json")
        ).expanduser().resolve()
        self.lock_path = self.state_path.with_suffix(self.state_path.suffix + ".lock")
        self._clock = clock
        self._lock = threading.RLock()

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
                os.write(
                    descriptor,
                    f"{os.getpid()} {self._clock()}\n".encode("ascii"),
                )
                os.fsync(descriptor)
            except (FileExistsError, PermissionError):
                # On Windows an exclusive create racing another handle can be
                # reported as EACCES instead of EEXIST. Treat both as lock
                # contention and keep the same bounded timeout semantics.
                try:
                    if self._clock() - self.lock_path.stat().st_mtime > STALE_LOCK_SECONDS:
                        self.lock_path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                except PermissionError:
                    pass
                if time.monotonic() >= deadline:
                    raise TeamRuntimeError(
                        "STATE_BUSY",
                        "timed out waiting for team state lock",
                    )
                time.sleep(0.02)
        try:
            yield
        finally:
            if descriptor is not None:
                os.close(descriptor)
            self.lock_path.unlink(missing_ok=True)

    @staticmethod
    def _empty_state() -> dict[str, Any]:
        return {"schema_version": SCHEMA_VERSION, "revision": 0, "teams": {}}

    def _load_unlocked(self) -> dict[str, Any]:
        try:
            if self.state_path.stat().st_size > MAX_STATE_BYTES:
                raise TeamRuntimeError("STATE_INVALID", "team state is too large")
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return self._empty_state()
        except (OSError, json.JSONDecodeError) as exc:
            raise TeamRuntimeError(
                "STATE_INVALID",
                f"team state cannot be read: {exc.__class__.__name__}",
            ) from None
        if (
            not isinstance(payload, dict)
            or payload.get("schema_version") != SCHEMA_VERSION
            or not isinstance(payload.get("teams"), dict)
        ):
            raise TeamRuntimeError("STATE_INVALID", "team state has an unsupported shape")
        return payload

    def _write_unlocked(self, state: dict[str, Any]) -> None:
        state["revision"] = int(state.get("revision", 0)) + 1
        body = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
        encoded = body.encode("utf-8")
        if len(encoded) > MAX_STATE_BYTES:
            raise TeamRuntimeError("STATE_LIMIT", "team state exceeds the storage limit")
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.state_path.name}.",
            suffix=".tmp",
            dir=self.state_path.parent,
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.state_path)
        finally:
            temporary.unlink(missing_ok=True)

    @contextmanager
    def _mutating_state(self) -> Iterator[dict[str, Any]]:
        with self._lock, self._state_lock():
            state = self._load_unlocked()
            yield state
            self._write_unlocked(state)

    def _read_state(self) -> dict[str, Any]:
        with self._lock, self._state_lock():
            return self._load_unlocked()

    @staticmethod
    def _team(state: dict[str, Any], session_id: Any) -> dict[str, Any]:
        if not isinstance(session_id, str) or not session_id.strip():
            raise TeamRuntimeError("INVALID_PARAMS", "session_id must be a non-empty string")
        team = state["teams"].get(session_id.strip())
        if not isinstance(team, dict):
            raise TeamRuntimeError("TEAM_NOT_FOUND", "the session does not own a team")
        return team

    @staticmethod
    def _member(team: dict[str, Any], member_name: str) -> dict[str, Any]:
        member = team["members"].get(member_name.casefold())
        if not isinstance(member, dict):
            raise TeamRuntimeError("MEMBER_NOT_FOUND", f"team member not found: {member_name}")
        return member

    @staticmethod
    def _require_lead(actor: str) -> None:
        if actor.casefold() != "lead":
            raise TeamRuntimeError("TEAM_ACCESS_DENIED", "only the team lead can perform this operation")

    def has_team(self, session_id: Any) -> bool:
        if not isinstance(session_id, str) or not session_id.strip():
            return False
        return session_id.strip() in self._read_state()["teams"]

    def create(
        self,
        session_id: Any,
        name: Any,
        description: Any = "",
    ) -> dict[str, Any]:
        if not isinstance(session_id, str) or not session_id.strip():
            raise TeamRuntimeError("INVALID_PARAMS", "session_id must be a non-empty string")
        team_name = _clean_text(name, "name", maximum=64)
        team_description = _clean_text(
            description,
            "description",
            maximum=MAX_DESCRIPTION_CHARS,
            required=False,
        )
        session_key = session_id.strip()
        now = _now_iso(self._clock)
        with self._mutating_state() as state:
            if session_key in state["teams"]:
                raise TeamRuntimeError("TEAM_EXISTS", "the session already owns a team")
            team = {
                "team_id": f"team_{uuid.uuid4().hex[:16]}",
                "session_id": session_key,
                "name": team_name,
                "description": team_description,
                "created_at": now,
                "updated_at": now,
                "next_sequence": 1,
                "members": {
                    "lead": {
                        "name": "lead",
                        "role": "lead",
                        "status": "active",
                        "joined_at": now,
                        "updated_at": now,
                    }
                },
                "messages": [],
                "shutdown_requests": {},
            }
            state["teams"][session_key] = team
        return self._public_team(team)

    def get(self, session_id: Any) -> dict[str, Any]:
        state = self._read_state()
        return self._public_team(self._team(state, session_id))

    def add_member(
        self,
        session_id: Any,
        member_name: Any,
        role: Any,
        *,
        actor: str = "lead",
    ) -> dict[str, Any]:
        self._require_lead(actor)
        name = _clean_member_name(member_name)
        role_name = _clean_text(role, "role", maximum=80)
        from arforge.multiagent.sub_agent_pool import get_sub_agent_pool

        if not get_sub_agent_pool().is_registered(role_name):
            raise TeamRuntimeError("INVALID_ROLE", f"unknown subagent role: {role_name}")
        now = _now_iso(self._clock)
        with self._mutating_state() as state:
            team = self._team(state, session_id)
            if len(team["members"]) - 1 >= MAX_MEMBERS:
                raise TeamRuntimeError("TEAM_LIMIT", f"a team supports at most {MAX_MEMBERS} collaborators")
            if name.casefold() in team["members"]:
                raise TeamRuntimeError("MEMBER_EXISTS", f"team member already exists: {name}")
            if any(
                member.get("role") == role_name
                for key, member in team["members"].items()
                if key != "lead"
            ):
                raise TeamRuntimeError(
                    "ROLE_IN_USE",
                    f"role is already assigned to another team member: {role_name}",
                )
            member = {
                "name": name,
                "role": role_name,
                "status": "active",
                "joined_at": now,
                "updated_at": now,
            }
            team["members"][name.casefold()] = member
            team["updated_at"] = now
        return dict(member)

    def resolve_actor(self, session_id: Any, role_name: str | None) -> str:
        if not role_name:
            return "lead"
        state = self._read_state()
        team = self._team(state, session_id)
        matches = [
            member["name"]
            for key, member in team["members"].items()
            if key != "lead" and member.get("role") == role_name
        ]
        if len(matches) != 1:
            raise TeamRuntimeError(
                "TEAM_ACCESS_DENIED",
                f"active subagent role is not registered as a unique team member: {role_name}",
            )
        return matches[0]

    def send_message(
        self,
        session_id: Any,
        recipient: Any,
        message: Any,
        *,
        actor: str = "lead",
        summary: Any = "",
        kind: Any = "info",
    ) -> dict[str, Any]:
        target = _clean_text(recipient, "recipient", maximum=32)
        content = _clean_text(message, "message", maximum=MAX_MESSAGE_CHARS)
        preview = _clean_text(
            summary,
            "summary",
            maximum=MAX_SUMMARY_CHARS,
            required=False,
        ) or content.splitlines()[0][:MAX_SUMMARY_CHARS]
        if not isinstance(kind, str) or kind not in _MESSAGE_KINDS:
            raise TeamRuntimeError(
                "INVALID_PARAMS",
                f"kind must be one of: {', '.join(sorted(_MESSAGE_KINDS))}",
            )
        now = _now_iso(self._clock)
        with self._mutating_state() as state:
            team = self._team(state, session_id)
            sender = self._member(team, actor)
            if sender.get("status") == "stopped":
                raise TeamRuntimeError("MEMBER_STOPPED", f"team member is stopped: {actor}")
            if target == "*":
                recipients = [
                    member["name"]
                    for member in team["members"].values()
                    if member["name"].casefold() != actor.casefold()
                    and member.get("status") != "stopped"
                ]
            else:
                target_member = self._member(team, target)
                if target_member["name"].casefold() == actor.casefold():
                    raise TeamRuntimeError("INVALID_PARAMS", "cannot send a direct message to yourself")
                if target_member.get("status") == "stopped":
                    raise TeamRuntimeError("MEMBER_STOPPED", f"team member is stopped: {target}")
                recipients = [target_member["name"]]
            sequence = int(team.get("next_sequence", 1))
            record = {
                "message_id": f"msg_{uuid.uuid4().hex[:16]}",
                "sequence": sequence,
                "sender": sender["name"],
                "recipient": "*" if target == "*" else recipients[0],
                "recipients": recipients,
                "kind": kind,
                "summary": preview,
                "message": content,
                "created_at": now,
            }
            team["next_sequence"] = sequence + 1
            team["messages"].append(record)
            team["messages"] = team["messages"][-MAX_MESSAGES:]
            team["updated_at"] = now
        return dict(record)

    def list_messages(
        self,
        session_id: Any,
        *,
        actor: str = "lead",
        after_sequence: Any = 0,
        limit: Any = 50,
    ) -> dict[str, Any]:
        if isinstance(after_sequence, bool) or isinstance(limit, bool):
            raise TeamRuntimeError("INVALID_PARAMS", "message offsets must be integers")
        try:
            after = int(after_sequence)
            bounded_limit = int(limit)
        except (TypeError, ValueError):
            raise TeamRuntimeError("INVALID_PARAMS", "message offsets must be integers") from None
        if after < 0 or not 1 <= bounded_limit <= 100:
            raise TeamRuntimeError(
                "INVALID_PARAMS",
                "after_sequence must be non-negative and limit must be between 1 and 100",
            )
        state = self._read_state()
        team = self._team(state, session_id)
        member = self._member(team, actor)
        visible = [
            dict(item)
            for item in team["messages"]
            if int(item.get("sequence", 0)) > after
            and (
                item.get("recipient") == member["name"]
                or (
                    item.get("recipient") == "*"
                    and member["name"] in item.get("recipients", [])
                )
            )
        ]
        visible = visible[:bounded_limit]
        return {
            "team_id": team["team_id"],
            "member": member["name"],
            "messages": visible,
            "count": len(visible),
            "last_sequence": visible[-1]["sequence"] if visible else after,
        }

    def request_shutdown(
        self,
        session_id: Any,
        member_name: Any,
        reason: Any = "",
        *,
        actor: str = "lead",
    ) -> dict[str, Any]:
        self._require_lead(actor)
        target_name = _clean_member_name(member_name)
        cleaned_reason = _clean_text(
            reason,
            "reason",
            maximum=1_000,
            required=False,
        )
        now = _now_iso(self._clock)
        with self._mutating_state() as state:
            team = self._team(state, session_id)
            member = self._member(team, target_name)
            if member.get("status") == "stopped":
                raise TeamRuntimeError("MEMBER_STOPPED", f"team member is already stopped: {target_name}")
            if member.get("status") == "shutdown_requested":
                raise TeamRuntimeError(
                    "SHUTDOWN_PENDING",
                    f"shutdown is already pending for: {target_name}",
                )
            request_id = f"shutdown_{uuid.uuid4().hex[:16]}"
            request = {
                "request_id": request_id,
                "member": member["name"],
                "status": "pending",
                "reason": cleaned_reason,
                "requested_at": now,
                "responded_at": "",
                "response_reason": "",
            }
            team["shutdown_requests"][request_id] = request
            member["status"] = "shutdown_requested"
            member["updated_at"] = now
            self._append_structured_message(
                team,
                sender="lead",
                recipient=member["name"],
                kind="shutdown_request",
                summary=f"Shutdown requested for {member['name']}",
                content=cleaned_reason,
                request_id=request_id,
                now=now,
            )
            team["updated_at"] = now
        return dict(request)

    def respond_shutdown(
        self,
        session_id: Any,
        request_id: Any,
        approve: Any,
        reason: Any = "",
        *,
        actor: str,
    ) -> dict[str, Any]:
        request_key = _clean_text(request_id, "request_id", maximum=64)
        if not isinstance(approve, bool):
            raise TeamRuntimeError("INVALID_PARAMS", "approve must be a boolean")
        cleaned_reason = _clean_text(
            reason,
            "reason",
            maximum=1_000,
            required=False,
        )
        if not approve and not cleaned_reason:
            raise TeamRuntimeError(
                "INVALID_PARAMS",
                "reason is required when rejecting a shutdown request",
            )
        now = _now_iso(self._clock)
        with self._mutating_state() as state:
            team = self._team(state, session_id)
            member = self._member(team, actor)
            request = team["shutdown_requests"].get(request_key)
            if not isinstance(request, dict):
                raise TeamRuntimeError("SHUTDOWN_NOT_FOUND", "shutdown request was not found")
            if request.get("status") != "pending":
                raise TeamRuntimeError("SHUTDOWN_DECIDED", "shutdown request is already decided")
            if request.get("member", "").casefold() != member["name"].casefold():
                raise TeamRuntimeError(
                    "TEAM_ACCESS_DENIED",
                    "a member can only answer its own shutdown request",
                )
            request["status"] = "approved" if approve else "rejected"
            request["responded_at"] = now
            request["response_reason"] = cleaned_reason
            member["status"] = "stopped" if approve else "active"
            member["updated_at"] = now
            self._append_structured_message(
                team,
                sender=member["name"],
                recipient="lead",
                kind="shutdown_response",
                summary=f"Shutdown {'approved' if approve else 'rejected'} by {member['name']}",
                content=cleaned_reason,
                request_id=request_key,
                now=now,
                approve=approve,
            )
            team["updated_at"] = now
        return dict(request)

    @staticmethod
    def _append_structured_message(
        team: dict[str, Any],
        *,
        sender: str,
        recipient: str,
        kind: str,
        summary: str,
        content: str,
        request_id: str,
        now: str,
        approve: bool | None = None,
    ) -> None:
        sequence = int(team.get("next_sequence", 1))
        record = {
            "message_id": f"msg_{uuid.uuid4().hex[:16]}",
            "sequence": sequence,
            "sender": sender,
            "recipient": recipient,
            "recipients": [recipient],
            "kind": kind,
            "summary": summary,
            "message": content,
            "request_id": request_id,
            "created_at": now,
        }
        if approve is not None:
            record["approve"] = approve
        team["next_sequence"] = sequence + 1
        team["messages"].append(record)
        team["messages"] = team["messages"][-MAX_MESSAGES:]

    def remove_member(
        self,
        session_id: Any,
        member_name: Any,
        *,
        actor: str = "lead",
    ) -> dict[str, Any]:
        self._require_lead(actor)
        target_name = _clean_member_name(member_name)
        now = _now_iso(self._clock)
        with self._mutating_state() as state:
            team = self._team(state, session_id)
            member = self._member(team, target_name)
            if member.get("status") != "stopped":
                raise TeamRuntimeError(
                    "MEMBER_ACTIVE",
                    "request and receive shutdown approval before removing a member",
                )
            removed = dict(member)
            team["members"].pop(member["name"].casefold(), None)
            team["shutdown_requests"] = {
                key: value
                for key, value in team["shutdown_requests"].items()
                if value.get("member", "").casefold() != member["name"].casefold()
            }
            team["updated_at"] = now
        return {"removed": removed, "team_id": team["team_id"]}

    def delete(self, session_id: Any, *, actor: str = "lead") -> dict[str, Any]:
        self._require_lead(actor)
        with self._mutating_state() as state:
            team = self._team(state, session_id)
            active = [
                member["name"]
                for key, member in team["members"].items()
                if key != "lead" and member.get("status") != "stopped"
            ]
            if active:
                raise TeamRuntimeError(
                    "MEMBER_ACTIVE",
                    "cannot delete a team with active members: " + ", ".join(active),
                )
            removed = {
                "team_id": team["team_id"],
                "name": team["name"],
                "member_count": len(team["members"]) - 1,
                "message_count": len(team["messages"]),
            }
            state["teams"].pop(team["session_id"], None)
        return {"deleted": True, **removed}

    @staticmethod
    def _public_team(team: dict[str, Any]) -> dict[str, Any]:
        members = sorted(
            (dict(member) for member in team["members"].values()),
            key=lambda item: (item["name"].casefold() != "lead", item["name"].casefold()),
        )
        pending = sum(
            1
            for item in team["shutdown_requests"].values()
            if item.get("status") == "pending"
        )
        return {
            "team_id": team["team_id"],
            "session_id": team["session_id"],
            "name": team["name"],
            "description": team["description"],
            "created_at": team["created_at"],
            "updated_at": team["updated_at"],
            "members": members,
            "member_count": len(members) - 1,
            "message_count": len(team["messages"]),
            "pending_shutdowns": pending,
        }


_manager: TeamManager | None = None
_manager_lock = threading.Lock()


def get_team_manager() -> TeamManager:
    """Return a manager bound to the active Arforge profile."""

    global _manager
    expected_path = data_path("teams.json").expanduser().resolve()
    with _manager_lock:
        if _manager is None or _manager.state_path != expected_path:
            _manager = TeamManager(expected_path)
        return _manager


__all__ = [
    "MAX_MEMBERS",
    "TeamManager",
    "TeamRuntimeError",
    "get_team_manager",
]
