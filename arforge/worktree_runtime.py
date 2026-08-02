"""Session-scoped Git worktree lifecycle management."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from arforge.paths import data_path


UTC = timezone.utc
MAX_NAME_CHARS = 64
_NAME_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")
_STATE_VERSION = 1
_LOCK_TIMEOUT_SECONDS = 10.0
_STALE_LOCK_SECONDS = 120.0


class WorktreeError(ValueError):
    """Raised when a managed worktree operation cannot proceed safely."""


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def validate_worktree_name(name: str) -> str:
    value = str(name or "").strip()
    if not value:
        raise WorktreeError("worktree name must be a non-empty string")
    if len(value) > MAX_NAME_CHARS:
        raise WorktreeError(f"worktree name exceeds {MAX_NAME_CHARS} characters")
    segments = value.split("/")
    if any(
        not segment
        or segment in {".", ".."}
        or not _NAME_SEGMENT.fullmatch(segment)
        for segment in segments
    ):
        raise WorktreeError(
            "worktree name segments may contain only letters, digits, dots, underscores, and dashes"
        )
    return value


def _flat_name(name: str) -> str:
    return name.replace("/", "-")


class WorktreeManager:
    """Persisted worktree ownership and fail-closed cleanup."""

    def __init__(self, state_path: str | Path | None = None):
        self.state_path = Path(state_path or data_path("worktree_sessions.json"))
        self.lock_path = self.state_path.with_suffix(self.state_path.suffix + ".lock")
        self._lock = threading.RLock()

    @contextmanager
    def _state_lock(self) -> Iterator[None]:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + _LOCK_TIMEOUT_SECONDS
        fd: int | None = None
        while fd is None:
            try:
                fd = os.open(
                    self.lock_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
                os.write(fd, f"{os.getpid()} {time.time()}\n".encode("ascii"))
                os.fsync(fd)
            except FileExistsError:
                try:
                    if time.time() - self.lock_path.stat().st_mtime > _STALE_LOCK_SECONDS:
                        self.lock_path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    raise WorktreeError("timed out waiting for worktree state lock")
                time.sleep(0.05)
        try:
            yield
        finally:
            if fd is not None:
                os.close(fd)
            try:
                self.lock_path.unlink()
            except FileNotFoundError:
                pass

    def _load(self) -> dict[str, dict[str, Any]]:
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, json.JSONDecodeError) as exc:
            raise WorktreeError("worktree state file is unreadable") from exc
        if not isinstance(payload, dict) or payload.get("schema_version") != _STATE_VERSION:
            raise WorktreeError("unsupported worktree state schema")
        sessions = payload.get("sessions")
        if not isinstance(sessions, dict):
            raise WorktreeError("worktree state sessions must be an object")
        return {
            key: value
            for key, value in sessions.items()
            if isinstance(key, str) and isinstance(value, dict)
        }

    def _save(self, sessions: dict[str, dict[str, Any]]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        content = json.dumps(
            {"schema_version": _STATE_VERSION, "sessions": sessions},
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ) + "\n"
        temp_name = ""
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                delete=False,
                dir=str(self.state_path.parent),
            ) as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
                temp_name = handle.name
            os.replace(temp_name, self.state_path)
        finally:
            if temp_name:
                try:
                    Path(temp_name).unlink()
                except FileNotFoundError:
                    pass

    @staticmethod
    def _git(
        args: list[str],
        cwd: Path,
        *,
        timeout: int = 30,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_ASKPASS": "",
                "GCM_INTERACTIVE": "Never",
            }
        )
        creationflags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            if os.name == "nt"
            else 0
        )
        try:
            return subprocess.run(
                ["git", *args],
                cwd=str(cwd),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
                env=env,
                creationflags=creationflags,
            )
        except FileNotFoundError as exc:
            raise WorktreeError("git is not available on this system") from exc
        except subprocess.TimeoutExpired as exc:
            raise WorktreeError("git worktree operation timed out") from exc

    @classmethod
    def _git_text(cls, args: list[str], cwd: Path) -> str:
        result = cls._git(args, cwd)
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "git command failed").strip()
            raise WorktreeError(message)
        return result.stdout.strip()

    @staticmethod
    def _validate_record_ownership(
        session_id: str,
        record: dict[str, Any],
    ) -> tuple[Path, Path]:
        if record.get("session_id") != session_id:
            raise WorktreeError("managed worktree ownership record is inconsistent")
        repo_root = Path(str(record.get("repo_root", ""))).expanduser().resolve()
        worktree_path = Path(
            str(record.get("worktree_path", ""))
        ).expanduser().resolve()
        managed_parent = (repo_root.parent / ".arforge-worktrees").resolve()
        try:
            worktree_path.relative_to(managed_parent)
        except ValueError as exc:
            raise WorktreeError(
                "managed worktree path is outside the controlled directory"
            ) from exc
        branch = str(record.get("worktree_branch", ""))
        if not branch.startswith("arforge-worktree-"):
            raise WorktreeError("managed worktree branch ownership is invalid")
        return repo_root, worktree_path

    def active_workspace(self, session_id: str) -> Path | None:
        with self._lock:
            sessions = self._load()
            record = sessions.get(session_id)
            if not record or record.get("status") != "active":
                return None
            _, path = self._validate_record_ownership(session_id, record)
            return path if path.is_dir() else None

    def has_active(self, session_id: str) -> bool:
        return self.active_workspace(session_id) is not None

    def enter(
        self,
        session_id: str,
        workspace: str | Path,
        name: str,
    ) -> dict[str, Any]:
        session_key = str(session_id or "").strip()
        if not session_key:
            raise WorktreeError("session_id must be a non-empty string")
        slug = validate_worktree_name(name)
        original_root = Path(workspace).expanduser().resolve()

        with self._lock, self._state_lock():
            sessions = self._load()
            existing = sessions.get(session_key)
            if existing and existing.get("status") in {"active", "cleanup_required"}:
                raise WorktreeError(
                    "session already owns an active or incomplete managed worktree"
                )

            repo_root = Path(
                self._git_text(["rev-parse", "--show-toplevel"], original_root)
            ).resolve()
            status = self._git_text(["status", "--porcelain=v1"], repo_root)
            if status:
                raise WorktreeError(
                    "commit or stash local changes before entering an isolated worktree"
                )
            base_commit = self._git_text(["rev-parse", "HEAD"], repo_root)
            original_branch = self._git_text(
                ["branch", "--show-current"],
                repo_root,
            )
            flat = _flat_name(slug)
            branch = f"arforge-worktree-{flat}"
            if len(branch) > 128:
                raise WorktreeError("derived worktree branch exceeds 128 characters")
            target_parent = (repo_root.parent / ".arforge-worktrees").resolve()
            target = (target_parent / flat).resolve()
            try:
                target.relative_to(target_parent)
            except ValueError as exc:
                raise WorktreeError("worktree destination escapes the managed directory") from exc
            if target.exists():
                raise WorktreeError("worktree destination already exists")
            branch_check = self._git(["show-ref", "--verify", f"refs/heads/{branch}"], repo_root)
            if branch_check.returncode == 0:
                raise WorktreeError("worktree branch already exists")

            target_parent.mkdir(parents=True, exist_ok=True)
            created = self._git(
                ["worktree", "add", "-b", branch, str(target), base_commit],
                repo_root,
                timeout=60,
            )
            if created.returncode != 0:
                message = (
                    created.stderr
                    or created.stdout
                    or "git worktree creation failed"
                ).strip()
                raise WorktreeError(message)

            now = _utc_now()
            record = {
                "session_id": session_key,
                "name": slug,
                "status": "active",
                "original_root": str(original_root),
                "repo_root": str(repo_root),
                "worktree_path": str(target),
                "worktree_branch": branch,
                "original_branch": original_branch,
                "base_commit": base_commit,
                "created_at": now,
                "updated_at": now,
            }
            sessions[session_key] = record
            self._save(sessions)
            return self._public(record)

    def _change_summary(self, record: dict[str, Any]) -> dict[str, int] | None:
        path = Path(str(record.get("worktree_path", "")))
        if not path.is_dir():
            return None
        status = self._git(["status", "--porcelain=v1"], path)
        if status.returncode != 0:
            return None
        changed_files = sum(1 for line in status.stdout.splitlines() if line.strip())
        base_commit = str(record.get("base_commit", ""))
        if not base_commit:
            return None
        rev_list = self._git(
            ["rev-list", "--count", f"{base_commit}..HEAD"],
            path,
        )
        if rev_list.returncode != 0:
            return None
        try:
            commits = int(rev_list.stdout.strip() or "0")
        except ValueError:
            return None
        return {"changed_files": changed_files, "commits": max(commits, 0)}

    def status(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            sessions = self._load()
            record = sessions.get(session_id)
            if record is None:
                return {"active": False, "managed": False, "session_id": session_id}
            self._validate_record_ownership(session_id, record)
            result = self._public(record)
            result["managed"] = True
            result["active"] = record.get("status") == "active"
            if result["active"]:
                summary = self._change_summary(record)
                result["change_state_known"] = summary is not None
                if summary is not None:
                    result.update(summary)
            return result

    def exit(
        self,
        session_id: str,
        action: str,
        *,
        discard_changes: bool = False,
    ) -> dict[str, Any]:
        if action not in {"keep", "remove"}:
            raise WorktreeError("action must be keep or remove")
        with self._lock, self._state_lock():
            sessions = self._load()
            record = sessions.get(session_id)
            if record is None or record.get("status") not in {
                "active",
                "cleanup_required",
            }:
                raise WorktreeError(
                    "no active managed worktree belongs to this session"
                )
            if record.get("status") == "cleanup_required" and action != "remove":
                raise WorktreeError("worktree cleanup is incomplete; retry remove")
            repo_root, worktree_path = self._validate_record_ownership(
                session_id,
                record,
            )

            summary = self._change_summary(record)
            if action == "remove" and not discard_changes:
                if summary is None:
                    raise WorktreeError(
                        "could not verify worktree changes; set discard_changes=true or keep it"
                    )
                if summary["changed_files"] or summary["commits"]:
                    raise WorktreeError(
                        "worktree has uncommitted files or new commits; "
                        "set discard_changes=true only after explicit user confirmation"
                    )

            now = _utc_now()
            if action == "keep":
                record["status"] = "kept"
                record["updated_at"] = now
                sessions[session_id] = record
                self._save(sessions)
                result = self._public(record)
                result.update(summary or {})
                result["action"] = "keep"
                return result

            if worktree_path.exists():
                remove_args = ["worktree", "remove"]
                if discard_changes:
                    remove_args.append("--force")
                remove_args.append(str(worktree_path))
                removed = self._git(remove_args, repo_root, timeout=60)
                if removed.returncode != 0:
                    message = (
                        removed.stderr
                        or removed.stdout
                        or "git worktree removal failed"
                    ).strip()
                    raise WorktreeError(message)

            record["status"] = "cleanup_required"
            record["updated_at"] = now
            sessions[session_id] = record
            self._save(sessions)

            branch_flag = "-D" if discard_changes else "-d"
            branch_result = self._git(
                ["branch", branch_flag, str(record["worktree_branch"])],
                repo_root,
            )
            if branch_result.returncode != 0:
                message = (
                    branch_result.stderr
                    or branch_result.stdout
                    or "worktree branch cleanup failed"
                ).strip()
                raise WorktreeError(
                    f"worktree directory removed but branch cleanup is incomplete: {message}"
                )

            record["status"] = "removed"
            record["updated_at"] = _utc_now()
            sessions[session_id] = record
            self._save(sessions)
            result = self._public(record)
            result.update(summary or {})
            result["action"] = "remove"
            result["discard_changes"] = bool(discard_changes)
            return result

    @staticmethod
    def _public(record: dict[str, Any]) -> dict[str, Any]:
        keys = (
            "session_id",
            "name",
            "status",
            "original_root",
            "repo_root",
            "worktree_path",
            "worktree_branch",
            "original_branch",
            "base_commit",
            "created_at",
            "updated_at",
        )
        return {key: record.get(key) for key in keys}


_MANAGERS: dict[str, WorktreeManager] = {}
_MANAGERS_LOCK = threading.Lock()


def get_worktree_manager(
    state_path: str | Path | None = None,
) -> WorktreeManager:
    path = Path(state_path or data_path("worktree_sessions.json")).resolve()
    key = str(path)
    with _MANAGERS_LOCK:
        manager = _MANAGERS.get(key)
        if manager is None:
            manager = WorktreeManager(path)
            _MANAGERS[key] = manager
        return manager


def reset_worktree_managers() -> None:
    with _MANAGERS_LOCK:
        _MANAGERS.clear()


__all__ = [
    "WorktreeError",
    "WorktreeManager",
    "get_worktree_manager",
    "reset_worktree_managers",
    "validate_worktree_name",
]
