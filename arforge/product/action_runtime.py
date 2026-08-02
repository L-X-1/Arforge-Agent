"""Approval and diff state machines for Machine Bridge workspace actions."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from arforge.logger import write_log
from arforge.security.diff_generator import generate_unified_diff
from arforge.security.file_ops import safe_delete, safe_write

UTC = timezone.utc

if TYPE_CHECKING:
    from arforge.product.state_store import BridgeStateStore

MAX_CONTENT_BYTES = 1024 * 1024
DEFAULT_APPROVAL_TTL_SECONDS = 300
MAX_APPROVAL_TTL_SECONDS = 1800


class ActionRuntimeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _format_time(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _content_hash(content: str, *, exists: bool = True) -> str:
    marker = b"file\0" if exists else b"missing\0"
    return hashlib.sha256(marker + content.encode("utf-8")).hexdigest()


@dataclass
class ApprovalRecord:
    approval_id: str
    session_id: str
    action_type: str
    subject_id: str
    risk: str
    summary: str
    status: str
    created_at: datetime
    expires_at: datetime
    decided_at: datetime | None = None

    def public(self) -> dict[str, Any]:
        return {
            "approval_id": self.approval_id,
            "session_id": self.session_id,
            "action_type": self.action_type,
            "subject_id": self.subject_id,
            "risk": self.risk,
            "summary": self.summary,
            "status": self.status,
            "created_at": _format_time(self.created_at),
            "expires_at": _format_time(self.expires_at),
            "decided_at": _format_time(self.decided_at) if self.decided_at else None,
        }


@dataclass
class DiffRecord:
    diff_id: str
    session_id: str
    relative_path: str
    original_content: str
    new_content: str
    original_exists: bool
    original_hash: str
    new_hash: str
    unified_diff: str
    stats: dict[str, int]
    status: str
    created_at: datetime
    approval_id: str
    backup_path: str = ""
    rollback_approval_id: str = ""
    error: str = ""

    def public(self, approval: ApprovalRecord | None = None) -> dict[str, Any]:
        result = {
            "diff_id": self.diff_id,
            "session_id": self.session_id,
            "file_path": self.relative_path,
            "status": self.status,
            "created_at": _format_time(self.created_at),
            "original_hash": self.original_hash,
            "new_hash": self.new_hash,
            "unified_diff": self.unified_diff,
            "stats": self.stats,
            "approval_id": self.approval_id,
            "rollback_approval_id": self.rollback_approval_id or None,
            "error": self.error or None,
        }
        if approval is not None:
            result["approval"] = approval.public()
        return result


@dataclass
class ToolActionRecord:
    action_id: str
    session_id: str
    tool_name: str
    arguments: dict[str, Any]
    risk: str
    status: str
    created_at: datetime
    approval_id: str
    result: dict[str, Any] | None = None

    def public(self, approval: ApprovalRecord | None = None) -> dict[str, Any]:
        response = {
            "action_id": self.action_id,
            "session_id": self.session_id,
            "tool_name": self.tool_name,
            "arguments": self.arguments,
            "risk": self.risk,
            "status": self.status,
            "created_at": _format_time(self.created_at),
            "approval_id": self.approval_id,
            "result": self.result,
        }
        if approval is not None:
            response["approval"] = approval.public()
        return response


@dataclass
class FileWriteRecord:
    """An externally-targeted file write (e.g. to the user's Desktop).

    Unlike workspace diffs, file writes may target absolute paths outside the
    workspace root, so they carry an explicit risk tier, overwrite flag, and the
    resolved absolute path. The content is held in-memory between preview and
    apply so nothing is written to disk until the user approves.
    """

    artifact_id: str
    session_id: str
    target_path: str
    content: str
    encoding: str
    overwrite: bool
    risk: str
    status: str  # previewed | applied | rejected | failed | rolled_back
    created_at: datetime
    approval_id: str
    size_bytes: int = 0
    mime: str = "text/plain"
    original_exists: bool = False
    original_hash: str = ""
    new_hash: str = ""
    backup_path: str = ""
    rollback_approval_id: str = ""
    error: str = ""

    def public(self, approval: ApprovalRecord | None = None) -> dict[str, Any]:
        response = {
            "artifact_id": self.artifact_id,
            "session_id": self.session_id,
            "path": self.target_path,
            "status": self.status,
            "risk": self.risk,
            "overwrite": self.overwrite,
            "size_bytes": self.size_bytes,
            "mime": self.mime,
            "created_at": _format_time(self.created_at),
            "approval_id": self.approval_id,
            "original_exists": self.original_exists,
            "error": self.error or None,
        }
        if approval is not None:
            response["approval"] = approval.public()
        return response

    def artifact_view(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "path": self.target_path,
            "mime": self.mime,
            "size_bytes": self.size_bytes,
            "created_at": _format_time(self.created_at),
            "source": "file.write",
        }


class ActionRuntime:
    """Own state transitions for approvals and exact-content file diffs."""

    def __init__(
        self,
        workspace_root: Path,
        emit: Callable[[dict[str, Any]], None] | None = None,
        *,
        max_records: int = 256,
        store: BridgeStateStore | None = None,
    ):
        self.workspace_root = Path(workspace_root).resolve()
        self._emit_callback = emit or (lambda _event: None)
        self._max_records = max_records
        self._store = store
        self._approvals: dict[str, ApprovalRecord] = {}
        self._diffs: dict[str, DiffRecord] = {}
        self._tools: dict[str, ToolActionRecord] = {}
        self._file_writes: dict[str, FileWriteRecord] = {}
        self._recovered_approvals: dict[str, dict[str, Any]] = {}
        self._recovered_actions: dict[str, dict[str, Any]] = {}
        self._sequence = 0
        self._lock = threading.RLock()
        if store is not None:
            self._recovered_approvals = {
                item["approval_id"]: item for item in store.load_approvals()
            }
            self._recovered_actions = {
                item["record_id"]: item for item in store.load_actions()
            }

    def preview_diff(
        self,
        session_id: str,
        file_path: str,
        new_content: str,
        ttl_seconds: int = DEFAULT_APPROVAL_TTL_SECONDS,
    ) -> dict[str, Any]:
        if not isinstance(session_id, str) or not session_id:
            raise ActionRuntimeError("INVALID_PARAMS", "session_id must be a non-empty string")
        if not isinstance(new_content, str):
            raise ActionRuntimeError("INVALID_PARAMS", "new_content must be a string")
        if len(new_content.encode("utf-8")) > MAX_CONTENT_BYTES:
            raise ActionRuntimeError("CONTENT_TOO_LARGE", "new_content exceeds 1 MiB")
        self._validate_ttl(ttl_seconds)
        target, relative = self._resolve_workspace_path(file_path)
        original_exists = target.exists()
        if original_exists and not target.is_file():
            raise ActionRuntimeError("INVALID_PATH", "target must be a regular file")
        if original_exists and target.stat().st_size > MAX_CONTENT_BYTES:
            raise ActionRuntimeError("CONTENT_TOO_LARGE", "current file exceeds 1 MiB")
        if not original_exists and not target.parent.is_dir():
            raise ActionRuntimeError("INVALID_PATH", "target parent directory does not exist")
        try:
            original = target.read_text(encoding="utf-8") if original_exists else ""
        except UnicodeDecodeError:
            raise ActionRuntimeError("BINARY_FILE", "binary files are not supported") from None
        if original == new_content:
            raise ActionRuntimeError("NO_CHANGES", "new content matches the current file")

        generated = generate_unified_diff(Path(relative), original, new_content)
        if generated.is_binary:
            raise ActionRuntimeError("BINARY_FILE", "binary files are not supported")
        now = _utc_now()
        with self._lock:
            self._prune()
            diff_id = str(uuid.uuid4())
            approval = self._create_approval(
                session_id=session_id,
                action_type="diff.apply",
                subject_id=diff_id,
                risk="high",
                summary=f"Apply reviewed changes to {relative}",
                ttl_seconds=ttl_seconds,
            )
            record = DiffRecord(
                diff_id=diff_id,
                session_id=session_id,
                relative_path=relative,
                original_content=original,
                new_content=new_content,
                original_exists=original_exists,
                original_hash=_content_hash(original, exists=original_exists),
                new_hash=_content_hash(new_content),
                unified_diff=generated.unified_diff,
                stats={
                    "additions": generated.stats.additions,
                    "deletions": generated.stats.deletions,
                    "hunks": generated.stats.hunk_count,
                },
                status="previewed",
                created_at=now,
                approval_id=approval.approval_id,
            )
            self._diffs[diff_id] = record
            self._persist_diff(record)
            self._emit("diff.previewed", session_id, {"diff_id": diff_id, "file_path": relative})
            return record.public(approval)

    def get_diff(self, session_id: str, diff_id: str) -> dict[str, Any]:
        with self._lock:
            recovered = self._recovered_actions.get(diff_id)
            if recovered is not None:
                if recovered["kind"] != "diff":
                    raise ActionRuntimeError("DIFF_NOT_FOUND", "diff not found")
                self._assert_session(session_id, recovered["session_id"])
                return self._public_recovered_diff(recovered)
            record = self._require_diff(diff_id)
            self._assert_session(session_id, record.session_id)
            approval = self._approvals.get(record.approval_id)
            if approval:
                self._expire_if_needed(approval)
            return record.public(approval)

    def reject_diff(self, session_id: str, diff_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_diff(diff_id)
            self._assert_session(session_id, record.session_id)
            if record.status == "rejected":
                return record.public(self._approvals.get(record.approval_id))
            if record.status != "previewed":
                raise ActionRuntimeError("INVALID_STATE", f"cannot reject diff in {record.status} state")
            record.status = "rejected"
            approval = self._approvals[record.approval_id]
            if approval.status in {"pending", "approved"}:
                approval.status = "rejected"
                approval.decided_at = _utc_now()
                self._persist_approval(approval)
            self._persist_diff(record)
            self._emit("diff.rejected", record.session_id, {"diff_id": diff_id})
            self._audit("diff_rejected", record)
            return record.public(approval)

    def apply_diff(self, session_id: str, diff_id: str, approval_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_diff(diff_id)
            self._assert_session(session_id, record.session_id)
            if record.status != "previewed":
                raise ActionRuntimeError("INVALID_STATE", f"cannot apply diff in {record.status} state")
            approval = self._require_approval(approval_id)
            self._consume_approval(approval, "diff.apply", diff_id, record.session_id)
            target, _relative = self._resolve_workspace_path(record.relative_path)
            current_exists, current = self._read_current(target)
            if _content_hash(current, exists=current_exists) != record.original_hash:
                record.status = "conflicted"
                record.error = "file changed after preview"
                self._persist_diff(record)
                self._emit("diff.conflicted", record.session_id, {"diff_id": diff_id})
                self._audit("diff_conflicted", record)
                raise ActionRuntimeError("DIFF_CONFLICT", record.error)
            if target.suffix.lower() == ".py":
                try:
                    compile(record.new_content, str(target), "exec")
                except SyntaxError as exc:
                    record.status = "failed"
                    record.error = f"Python syntax error at line {exc.lineno}"
                    self._persist_diff(record)
                    self._audit("diff_validation_failed", record)
                    raise ActionRuntimeError("VALIDATION_FAILED", record.error) from None

            result = safe_write(
                target,
                record.new_content,
                auto_backup=record.original_exists,
                require_confirm=False,
            )
            if not result.get("success"):
                record.status = "failed"
                record.error = "atomic file write failed"
                self._persist_diff(record)
                self._audit("diff_apply_failed", record)
                raise ActionRuntimeError("APPLY_FAILED", record.error)
            record.status = "applied"
            record.backup_path = str(result.get("backup_path", ""))
            rollback = self._create_approval(
                session_id=record.session_id,
                action_type="diff.rollback",
                subject_id=diff_id,
                risk="high",
                summary=f"Rollback reviewed changes to {record.relative_path}",
                ttl_seconds=DEFAULT_APPROVAL_TTL_SECONDS,
            )
            record.rollback_approval_id = rollback.approval_id
            self._persist_diff(record)
            self._emit("diff.applied", record.session_id, {"diff_id": diff_id, "file_path": record.relative_path})
            self._audit("diff_applied", record)
            result_public = record.public(approval)
            result_public["rollback_approval"] = rollback.public()
            return result_public

    def rollback_diff(self, session_id: str, diff_id: str, approval_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_diff(diff_id)
            self._assert_session(session_id, record.session_id)
            if record.status == "rolled_back":
                return record.public(self._approvals.get(record.rollback_approval_id))
            if record.status != "applied":
                raise ActionRuntimeError("INVALID_STATE", f"cannot rollback diff in {record.status} state")
            approval = self._require_approval(approval_id)
            self._consume_approval(approval, "diff.rollback", diff_id, record.session_id)
            target, _relative = self._resolve_workspace_path(record.relative_path)
            current_exists, current = self._read_current(target)
            if not current_exists or _content_hash(current) != record.new_hash:
                record.error = "file changed after apply"
                replacement = self._create_approval(
                    session_id=record.session_id,
                    action_type="diff.rollback",
                    subject_id=diff_id,
                    risk="high",
                    summary=f"Rollback reviewed changes to {record.relative_path}",
                    ttl_seconds=DEFAULT_APPROVAL_TTL_SECONDS,
                )
                record.rollback_approval_id = replacement.approval_id
                self._persist_diff(record)
                self._audit("diff_rollback_conflicted", record)
                raise ActionRuntimeError("DIFF_CONFLICT", record.error)

            if record.original_exists:
                result = safe_write(target, record.original_content, auto_backup=True, require_confirm=False)
            else:
                result = safe_delete(target, require_confirm=False)
            if not result.get("success"):
                record.error = "rollback file operation failed"
                self._persist_diff(record)
                self._audit("diff_rollback_failed", record)
                raise ActionRuntimeError("ROLLBACK_FAILED", record.error)
            record.status = "rolled_back"
            record.error = ""
            self._persist_diff(record)
            self._emit("diff.rolled_back", record.session_id, {"diff_id": diff_id})
            self._audit("diff_rolled_back", record)
            return record.public(approval)

    def get_approval(self, session_id: str, approval_id: str) -> dict[str, Any]:
        with self._lock:
            recovered = self._recovered_approvals.get(approval_id)
            if recovered is not None:
                self._assert_session(session_id, recovered["session_id"])
                return dict(recovered)
            approval = self._require_approval(approval_id)
            self._assert_session(session_id, approval.session_id)
            self._expire_if_needed(approval)
            return approval.public()

    def prepare_tool(
        self,
        session_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        ttl_seconds: int = DEFAULT_APPROVAL_TTL_SECONDS,
    ) -> dict[str, Any]:
        if not isinstance(session_id, str) or not session_id:
            raise ActionRuntimeError("INVALID_PARAMS", "session_id must be a non-empty string")
        if not isinstance(tool_name, str) or not tool_name:
            raise ActionRuntimeError("INVALID_PARAMS", "tool_name must be a non-empty string")
        if not isinstance(arguments, dict):
            raise ActionRuntimeError("INVALID_PARAMS", "arguments must be an object")
        try:
            encoded = json.dumps(arguments, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError):
            raise ActionRuntimeError("INVALID_PARAMS", "arguments must be JSON serializable") from None
        if len(encoded) > MAX_CONTENT_BYTES:
            raise ActionRuntimeError("CONTENT_TOO_LARGE", "tool arguments exceed 1 MiB")
        self._validate_ttl(ttl_seconds)

        from arforge import tool_executor as _tool_executor  # noqa: F401 - registers tools
        from arforge.tool_registry import REGISTRY

        definition = REGISTRY.get(tool_name)
        if definition is None or definition.execute_fn is None:
            raise ActionRuntimeError("TOOL_NOT_FOUND", "tool is not available")
        if definition.schema.risk_level == "critical":
            raise ActionRuntimeError("TOOL_BLOCKED", "critical-risk tools cannot be approved through the bridge")
        self._validate_tool_arguments(definition, arguments)

        with self._lock:
            self._prune()
            action_id = str(uuid.uuid4())
            approval = self._create_approval(
                session_id=session_id,
                action_type="tool.execute",
                subject_id=action_id,
                risk=definition.schema.risk_level,
                summary=f"Execute tool {tool_name}",
                ttl_seconds=ttl_seconds,
            )
            record = ToolActionRecord(
                action_id=action_id,
                session_id=session_id,
                tool_name=tool_name,
                arguments=dict(arguments),
                risk=definition.schema.risk_level,
                status="prepared",
                created_at=_utc_now(),
                approval_id=approval.approval_id,
            )
            self._tools[action_id] = record
            self._persist_tool(record)
            self._emit("tool.prepared", session_id, {"action_id": action_id, "tool_name": tool_name})
            self._audit_tool("tool_prepared", record)
            return record.public(approval)

    def get_tool_action(self, session_id: str, action_id: str) -> dict[str, Any]:
        with self._lock:
            recovered = self._recovered_actions.get(action_id)
            if recovered is not None:
                if recovered["kind"] != "tool":
                    raise ActionRuntimeError("TOOL_ACTION_NOT_FOUND", "tool action not found")
                self._assert_session(session_id, recovered["session_id"])
                return self._public_recovered_tool(recovered)
            record = self._require_tool_action(action_id)
            self._assert_session(session_id, record.session_id)
            approval = self._approvals.get(record.approval_id)
            if approval:
                self._expire_if_needed(approval)
            return record.public(approval)

    def retry_tool(
        self,
        session_id: str,
        action_id: str,
        ttl_seconds: int = DEFAULT_APPROVAL_TTL_SECONDS,
    ) -> dict[str, Any]:
        """Clone a failed tool action behind a fresh, one-time approval."""
        with self._lock:
            record = self._require_tool_action(action_id)
            self._assert_session(session_id, record.session_id)
            if record.status != "failed":
                raise ActionRuntimeError("RETRY_UNSAFE", "only failed tool actions can be retried")
            tool_name = record.tool_name
            arguments = dict(record.arguments)
        return self.prepare_tool(session_id, tool_name, arguments, ttl_seconds)

    def reject_tool(self, session_id: str, action_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_tool_action(action_id)
            self._assert_session(session_id, record.session_id)
            if record.status == "rejected":
                return record.public(self._approvals.get(record.approval_id))
            if record.status != "prepared":
                raise ActionRuntimeError("INVALID_STATE", f"cannot reject tool in {record.status} state")
            record.status = "rejected"
            approval = self._approvals[record.approval_id]
            if approval.status in {"pending", "approved"}:
                approval.status = "rejected"
                approval.decided_at = _utc_now()
                self._persist_approval(approval)
            self._persist_tool(record)
            self._emit("tool.rejected", record.session_id, {"action_id": action_id})
            self._audit_tool("tool_rejected", record)
            return record.public(approval)

    def execute_tool(self, session_id: str, action_id: str, approval_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_tool_action(action_id)
            self._assert_session(session_id, record.session_id)
            if record.status != "prepared":
                raise ActionRuntimeError("INVALID_STATE", f"cannot execute tool in {record.status} state")
            approval = self._require_approval(approval_id)
            self._consume_approval(approval, "tool.execute", action_id, record.session_id)
            record.status = "running"
            self._persist_tool(record)

        try:
            from arforge.security.file_ops import confirmed_operation
            from arforge.tool_executor import execute_tool_by_name
            from arforge.workspace_context import execution_scope

            with (
                execution_scope(record.session_id, workspace=self.workspace_root),
                confirmed_operation(),
            ):
                result = execute_tool_by_name(record.tool_name, dict(record.arguments))
        except Exception:
            with self._lock:
                record.status = "failed"
                record.result = {
                    "success": False,
                    "output": "",
                    "error": "tool execution failed unexpectedly",
                    "elapsed_ms": 0,
                    "truncated": False,
                }
                self._persist_tool(record)
                self._emit(
                    "tool.failed",
                    record.session_id,
                    {"action_id": action_id, "tool_name": record.tool_name, "success": False},
                )
                self._audit_tool("tool_failed", record)
            raise ActionRuntimeError("BACKEND_ERROR", "tool execution failed unexpectedly") from None
        with self._lock:
            record.result = {
                "success": result.success,
                "output": result.output,
                "error": result.error,
                "elapsed_ms": result.elapsed_ms,
                "truncated": result.truncated,
            }
            record.status = "succeeded" if result.success else "failed"
            self._persist_tool(record)
            self._emit(
                "tool.completed" if result.success else "tool.failed",
                record.session_id,
                {"action_id": action_id, "tool_name": record.tool_name, "success": result.success},
            )
            self._audit_tool("tool_completed" if result.success else "tool_failed", record)
            return record.public(approval)

    # ------------------------------------------------------------------
    # External file writes (e.g. Desktop) — preview -> approve -> apply
    # ------------------------------------------------------------------

    # System/credential/executable targets that are never writable, regardless of
    # approval. Matched against path *segments* (exact, case-insensitive), not as
    # substrings, so a legit path that merely traverses a temp dir is not blocked.
    _PROTECTED_PATH_SEGMENTS = {
        "windows", "system32", "syswow64", "program files", "program files (x86)",
        "boot", "recovery", "$recycle.bin", "system volume information",
        ".git", ".svn", ".hg", "node_modules", "__pycache__",
        ".ssh", ".aws", ".azure", ".gnupg",
    }
    _PROTECTED_SUFFIXES = {".exe", ".bat", ".cmd", ".ps1", ".com", ".scr", ".msi", ".dll", ".sys", ".vbs"}
    _SAFE_USER_DIRS = {"desktop", "documents", "downloads"}

    def preview_file_write(
        self,
        session_id: str,
        target_path: str,
        content: str,
        *,
        encoding: str = "utf-8",
        overwrite: bool = False,
        ttl_seconds: int = DEFAULT_APPROVAL_TTL_SECONDS,
    ) -> dict[str, Any]:
        """Stage an external file write behind an approval. Nothing is written.

        Risk tiering:
          * workspace-internal path ............ low
          * Desktop / Documents / Downloads .... medium (new file)
          * other user-directory new file ...... high
          * overwrite of an existing file ...... high (escalates medium)
          * system / credential / executable ... PROTECTED_PATH (rejected, no approval)
        """
        if not isinstance(session_id, str) or not session_id:
            raise ActionRuntimeError("INVALID_PARAMS", "session_id must be a non-empty string")
        if not isinstance(content, str):
            raise ActionRuntimeError("INVALID_PARAMS", "content must be a string")
        if not isinstance(encoding, str) or not encoding.strip():
            raise ActionRuntimeError("INVALID_PARAMS", "encoding must be a non-empty string")
        if encoding.lower() not in {"utf-8", "utf8", "ascii", "latin-1"}:
            raise ActionRuntimeError("INVALID_PARAMS", "only text encodings are supported")
        if not isinstance(overwrite, bool):
            raise ActionRuntimeError("INVALID_PARAMS", "overwrite must be a boolean")
        if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
            raise ActionRuntimeError("CONTENT_TOO_LARGE", "content exceeds 1 MiB")
        self._validate_ttl(ttl_seconds)

        target = self._resolve_external_path(target_path)
        exists = target.exists()
        if exists and not target.is_file():
            raise ActionRuntimeError("INVALID_PATH", "target must be a regular file")
        if exists and not overwrite:
            raise ActionRuntimeError("FILE_EXISTS", "file already exists; set overwrite=true to replace it")
        if not exists and not target.parent.exists():
            target.parent.mkdir(parents=True, exist_ok=True)

        risk = self._file_write_risk(target, exists=exists, overwrite=overwrite)
        size_bytes = len(content.encode("utf-8"))
        mime = self._mime_for(target)
        now = _utc_now()
        with self._lock:
            self._prune()
            artifact_id = str(uuid.uuid4())
            approval = self._create_approval(
                session_id=session_id,
                action_type="file.write.apply",
                subject_id=artifact_id,
                risk=risk,
                summary=self._file_write_summary(target, size_bytes, exists, overwrite),
                ttl_seconds=ttl_seconds,
            )
            record = FileWriteRecord(
                artifact_id=artifact_id,
                session_id=session_id,
                target_path=str(target),
                content=content,
                encoding=encoding,
                overwrite=overwrite,
                risk=risk,
                status="previewed",
                created_at=now,
                approval_id=approval.approval_id,
                size_bytes=size_bytes,
                mime=mime,
                original_exists=exists,
                original_hash=_content_hash(target.read_text(encoding="utf-8"), exists=True) if exists else "",
                new_hash=_content_hash(content),
            )
            self._file_writes[artifact_id] = record
            self._persist_file_write(record)
            preview = {
                "path": str(target),
                "size_bytes": size_bytes,
                "exists": exists,
                "overwrite": overwrite,
                "risk": risk,
                "mime": mime,
                "summary": self._file_write_summary(target, size_bytes, exists, overwrite),
                "content_preview": content[:200],
            }
            self._emit(
                "file.write.previewed",
                session_id,
                {"artifact_id": artifact_id, "path": str(target), "risk": risk},
            )
            result = record.public(approval)
            result["preview"] = preview
            result["artifact"] = record.artifact_view()
            return result

    def get_file_write(self, session_id: str, artifact_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_file_write(artifact_id)
            self._assert_session(session_id, record.session_id)
            approval = self._approvals.get(record.approval_id)
            if approval:
                self._expire_if_needed(approval)
            return record.public(approval)

    def reject_file_write(self, session_id: str, artifact_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_file_write(artifact_id)
            self._assert_session(session_id, record.session_id)
            if record.status == "rejected":
                return record.public(self._approvals.get(record.approval_id))
            if record.status != "previewed":
                raise ActionRuntimeError("INVALID_STATE", f"cannot reject file write in {record.status} state")
            record.status = "rejected"
            approval = self._approvals.get(record.approval_id)
            if approval and approval.status in {"pending", "approved"}:
                approval.status = "rejected"
                approval.decided_at = _utc_now()
                self._persist_approval(approval)
            self._persist_file_write(record)
            self._emit("file.write.rejected", record.session_id, {"artifact_id": artifact_id})
            return record.public(approval)

    def apply_file_write(self, session_id: str, artifact_id: str, approval_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._require_file_write(artifact_id)
            self._assert_session(session_id, record.session_id)
            if record.status == "applied":
                return record.public(self._approvals.get(record.approval_id))
            if record.status != "previewed":
                raise ActionRuntimeError("INVALID_STATE", f"cannot apply file write in {record.status} state")
            approval = self._require_approval(approval_id)
            self._consume_approval(approval, "file.write.apply", artifact_id, record.session_id)
            record.status = "running"
            self._persist_file_write(record)

        try:
            result = safe_write(
                Path(record.target_path),
                record.content,
                encoding=record.encoding,
                auto_backup=record.original_exists,
                require_confirm=False,
            )
        except Exception as exc:
            with self._lock:
                record.status = "failed"
                record.error = "file write failed unexpectedly"
                self._persist_file_write(record)
                self._emit("file.write.failed", record.session_id, {"artifact_id": artifact_id})
            raise ActionRuntimeError("BACKEND_ERROR", "file write failed unexpectedly") from exc

        with self._lock:
            if not result.get("success"):
                record.status = "failed"
                record.error = str(result.get("error", "atomic file write failed")) or "write failed"
                self._persist_file_write(record)
                self._emit("file.write.failed", record.session_id, {"artifact_id": artifact_id})
                raise ActionRuntimeError("APPLY_FAILED", record.error)
            record.status = "applied"
            record.backup_path = str(result.get("backup_path", ""))
            rollback = self._create_approval(
                session_id=record.session_id,
                action_type="file.write.rollback",
                subject_id=artifact_id,
                risk="high",
                summary=f"Rollback file write to {record.target_path}",
                ttl_seconds=DEFAULT_APPROVAL_TTL_SECONDS,
            )
            record.rollback_approval_id = rollback.approval_id
            self._persist_file_write(record)
            artifact = record.artifact_view()
            self._emit(
                "artifact.created",
                record.session_id,
                {"artifact_id": artifact_id, "artifact": artifact},
            )
            public = record.public(self._approvals.get(record.approval_id))
            public["artifact"] = artifact
            public["rollback_approval"] = rollback.public()
            return public

    def _resolve_external_path(self, target_path: str) -> Path:
        """Resolve a user-facing path to an absolute Path, enforcing safety.

        Workspace-relative paths resolve under the workspace root. Absolute paths
        and ``~`` / ``%USERPROFILE%`` references expand to a real location but
        are rejected if they fall into protected system/credential/executable
        territory.
        """
        if not isinstance(target_path, str) or not target_path.strip():
            raise ActionRuntimeError("INVALID_PATH", "target_path must be a non-empty string")
        candidate = target_path.strip()
        # Expand user home / USERPROFILE so "Desktop" requests resolve naturally.
        expanded = os.path.expandvars(os.path.expanduser(candidate))
        if os.path.isabs(expanded):
            resolved = Path(expanded).resolve()
        else:
            # Treat bare names like "Desktop/x.txt" as user-home relative, matching
            # how a user would phrase "put it on the Desktop".
            resolved = (Path(os.path.expanduser("~")) / expanded).resolve()
        resolved_str = str(resolved).replace("\\", "/").lower()
        segments = {part for part in resolved_str.split("/") if part}
        if segments & self._PROTECTED_PATH_SEGMENTS:
            raise ActionRuntimeError(
                "PROTECTED_PATH",
                "target is in a protected system, credential, or build directory",
            )
        if resolved.suffix.lower() in self._PROTECTED_SUFFIXES:
            raise ActionRuntimeError(
                "PROTECTED_PATH",
                "writing executables and system binaries is not allowed",
            )
        # Block path traversal that escapes above the user home for relative-style
        # inputs, but allow genuine absolute user paths (Desktop/Documents).
        home = Path(os.path.expanduser("~")).resolve()
        try:
            resolved.relative_to(home)
        except ValueError:
            # An absolute path outside the home dir is allowed only if it is not
            # already covered by the workspace (e.g. a second drive) — but it must
            # still not be a root or system path, already guarded above.
            if resolved.parent == resolved.parents[-1]:
                raise ActionRuntimeError("PROTECTED_PATH", "cannot write to a filesystem root") from None
        return resolved

    def _file_write_risk(self, target: Path, *, exists: bool, overwrite: bool) -> str:
        # Inside the workspace is the safest tier.
        try:
            target.relative_to(self.workspace_root)
            base = "low"
        except ValueError:
            parent_name = target.parent.name.lower()
            base = "medium" if parent_name in self._SAFE_USER_DIRS else "high"
        # Overwriting an existing file always escalates to high.
        if exists and overwrite:
            base = "high"
        return base

    @staticmethod
    def _file_write_summary(target: Path, size_bytes: int, exists: bool, overwrite: bool) -> str:
        action = "Overwrite" if exists and overwrite else "Create"
        return f"{action} {target.name} ({size_bytes} bytes) at {target.parent}"

    @staticmethod
    def _mime_for(target: Path) -> str:
        suffix = target.suffix.lower()
        mapping = {
            ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
            ".csv": "text/csv", ".html": "text/html", ".xml": "application/xml",
            ".log": "text/plain", ".py": "text/x-python", ".js": "text/javascript",
        }
        return mapping.get(suffix, "text/plain")

    def _require_file_write(self, artifact_id: str) -> FileWriteRecord:
        if not isinstance(artifact_id, str) or not artifact_id:
            raise ActionRuntimeError("INVALID_PARAMS", "artifact_id must be a non-empty string")
        record = self._file_writes.get(artifact_id)
        if record is None:
            raise ActionRuntimeError("ARTIFACT_NOT_FOUND", "file write artifact not found")
        return record

    def _persist_file_write(self, record: FileWriteRecord) -> None:
        if self._store is not None:
            approval = self._approvals.get(record.approval_id)
            self._store.save_action(
                {
                    "record_id": record.artifact_id,
                    "session_id": record.session_id,
                    "kind": "file.write",
                    "status": record.status,
                    "label": record.target_path,
                    "risk": approval.risk if approval else record.risk,
                    "created_at": _format_time(record.created_at),
                    "approval_id": record.approval_id,
                    "rollback_approval_id": record.rollback_approval_id or None,
                    "original_hash": record.original_hash,
                    "new_hash": record.new_hash,
                    "error": record.error or None,
                }
            )

    @staticmethod
    def _public_live_file_write(record: FileWriteRecord) -> dict[str, Any]:
        return {
            "record_id": record.artifact_id,
            "session_id": record.session_id,
            "kind": "file.write",
            "status": record.status,
            "label": record.target_path,
            "risk": record.risk,
            "created_at": _format_time(record.created_at),
            "approval_id": record.approval_id,
            "rollback_approval_id": record.rollback_approval_id or None,
            "error": record.error or None,
            "recovered": False,
            "payload_available": record.status == "previewed" or record.status == "applied",
        }

    def respond_approval(self, session_id: str, approval_id: str, decision: str) -> dict[str, Any]:
        if decision not in {"approve", "reject"}:
            raise ActionRuntimeError("INVALID_PARAMS", "decision must be approve or reject")
        with self._lock:
            approval = self._require_approval(approval_id)
            self._assert_session(session_id, approval.session_id)
            self._expire_if_needed(approval)
            desired = "approved" if decision == "approve" else "rejected"
            if approval.status == desired:
                return approval.public()
            if approval.status != "pending":
                raise ActionRuntimeError("APPROVAL_FINAL", f"approval is already {approval.status}")
            approval.status = desired
            approval.decided_at = _utc_now()
            self._persist_approval(approval)
            self._emit(
                "approval.resolved",
                approval.session_id,
                {"approval_id": approval_id, "status": desired},
            )
            self._audit_approval("approval_resolved", approval)
            return approval.public()

    def list_actions(self, session_id: str, limit: int = 50) -> dict[str, Any]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 200:
            raise ActionRuntimeError("INVALID_PARAMS", "limit must be an integer between 1 and 200")
        if not isinstance(session_id, str) or not session_id:
            raise ActionRuntimeError("INVALID_PARAMS", "session_id must be a non-empty string")
        with self._lock:
            items: list[dict[str, Any]] = []
            items.extend(self._public_recovered_action(item) for item in self._recovered_actions.values() if item["session_id"] == session_id)
            items.extend(self._public_live_diff(item) for item in self._diffs.values() if item.session_id == session_id)
            items.extend(self._public_live_tool(item) for item in self._tools.values() if item.session_id == session_id)
            items.extend(self._public_live_file_write(item) for item in self._file_writes.values() if item.session_id == session_id)
            items.sort(key=lambda item: item["created_at"], reverse=True)
            selected = items[:limit]
            return {"items": selected, "count": len(selected), "total": len(items)}

    def list_file_history(self, session_id: str, file_path: str, limit: int = 50) -> dict[str, Any]:
        """Return a session-scoped, metadata-only revision history for one file.

        Durable history intentionally stores hashes and action metadata rather
        than file contents. This keeps revisions auditable after a restart
        without retaining potentially sensitive source code in the state store.
        """
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 200:
            raise ActionRuntimeError("INVALID_PARAMS", "limit must be an integer between 1 and 200")
        _target, relative_path = self._resolve_workspace_path(file_path)
        if not isinstance(session_id, str) or not session_id:
            raise ActionRuntimeError("INVALID_PARAMS", "session_id must be a non-empty string")
        with self._lock:
            items = [
                self._public_file_history_live(record)
                for record in self._diffs.values()
                if record.session_id == session_id and record.relative_path == relative_path
            ]
            items.extend(
                self._public_file_history_recovered(record)
                for record in self._recovered_actions.values()
                if record["session_id"] == session_id
                and record["kind"] == "diff"
                and record["label"] == relative_path
            )
            items.sort(key=lambda item: item["created_at"], reverse=True)
            selected = items[:limit]
            return {
                "file_path": relative_path,
                "items": selected,
                "count": len(selected),
                "total": len(items),
            }

    def has_open_actions(self, session_id: str) -> bool:
        """Return whether closing the session would orphan a pending decision."""
        with self._lock:
            for approval in self._approvals.values():
                if approval.session_id == session_id:
                    self._expire_if_needed(approval)
            if any(
                record.session_id == session_id and record.status == "previewed"
                for record in self._diffs.values()
            ):
                return True
            if any(
                record.session_id == session_id and record.status in {"prepared", "running"}
                for record in self._tools.values()
            ):
                return True
            if any(
                record.session_id == session_id and record.status == "previewed"
                for record in self._file_writes.values()
            ):
                return True
            return any(
                approval.session_id == session_id and approval.status in {"pending", "approved"}
                for approval in self._approvals.values()
            )

    def _create_approval(
        self,
        *,
        session_id: str,
        action_type: str,
        subject_id: str,
        risk: str,
        summary: str,
        ttl_seconds: int,
    ) -> ApprovalRecord:
        now = _utc_now()
        approval = ApprovalRecord(
            approval_id=str(uuid.uuid4()),
            session_id=session_id,
            action_type=action_type,
            subject_id=subject_id,
            risk=risk,
            summary=summary,
            status="pending",
            created_at=now,
            expires_at=now + timedelta(seconds=ttl_seconds),
        )
        self._approvals[approval.approval_id] = approval
        self._persist_approval(approval)
        self._emit("approval.requested", session_id, approval.public())
        self._audit_approval("approval_requested", approval)
        return approval

    def _consume_approval(
        self,
        approval: ApprovalRecord,
        action_type: str,
        subject_id: str,
        session_id: str,
    ) -> None:
        self._expire_if_needed(approval)
        if (
            approval.action_type != action_type
            or approval.subject_id != subject_id
            or approval.session_id != session_id
        ):
            raise ActionRuntimeError("APPROVAL_MISMATCH", "approval does not authorize this action")
        if approval.status != "approved":
            raise ActionRuntimeError("APPROVAL_REQUIRED", f"approval status is {approval.status}")
        approval.status = "consumed"
        approval.decided_at = _utc_now()
        self._persist_approval(approval)

    def _expire_if_needed(self, approval: ApprovalRecord) -> None:
        if approval.status in {"pending", "approved"} and _utc_now() >= approval.expires_at:
            approval.status = "expired"
            approval.decided_at = _utc_now()
            self._persist_approval(approval)
            self._emit(
                "approval.expired",
                approval.session_id,
                {"approval_id": approval.approval_id},
            )
            self._audit_approval("approval_expired", approval)

    def _resolve_workspace_path(self, file_path: str) -> tuple[Path, str]:
        if not isinstance(file_path, str) or not file_path.strip():
            raise ActionRuntimeError("INVALID_PATH", "file_path must be a non-empty relative path")
        supplied = Path(file_path)
        if supplied.is_absolute():
            raise ActionRuntimeError("PATH_OUTSIDE_WORKSPACE", "absolute paths are not allowed")
        target = (self.workspace_root / supplied).resolve()
        try:
            relative = target.relative_to(self.workspace_root)
        except ValueError:
            raise ActionRuntimeError("PATH_OUTSIDE_WORKSPACE", "path escapes the workspace") from None
        if any(part.lower() in {".git", ".venv"} for part in relative.parts):
            raise ActionRuntimeError("PROTECTED_PATH", "protected workspace paths cannot be modified")
        return target, relative.as_posix()

    @staticmethod
    def _read_current(target: Path) -> tuple[bool, str]:
        if not target.exists():
            return False, ""
        if not target.is_file():
            raise ActionRuntimeError("INVALID_PATH", "target must be a regular file")
        if target.stat().st_size > MAX_CONTENT_BYTES:
            raise ActionRuntimeError("CONTENT_TOO_LARGE", "current file exceeds 1 MiB")
        try:
            return True, target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raise ActionRuntimeError("BINARY_FILE", "binary files are not supported") from None

    @staticmethod
    def _validate_ttl(ttl_seconds: int) -> None:
        if not isinstance(ttl_seconds, int) or isinstance(ttl_seconds, bool):
            raise ActionRuntimeError("INVALID_PARAMS", "ttl_seconds must be an integer")
        if not 1 <= ttl_seconds <= MAX_APPROVAL_TTL_SECONDS:
            raise ActionRuntimeError(
                "INVALID_PARAMS",
                f"ttl_seconds must be between 1 and {MAX_APPROVAL_TTL_SECONDS}",
            )

    def _require_approval(self, approval_id: str) -> ApprovalRecord:
        if not isinstance(approval_id, str) or not approval_id:
            raise ActionRuntimeError("INVALID_PARAMS", "approval_id must be a non-empty string")
        approval = self._approvals.get(approval_id)
        if approval is None:
            if approval_id in self._recovered_approvals:
                raise ActionRuntimeError(
                    "PAYLOAD_UNAVAILABLE",
                    "approval was invalidated after process restart",
                )
            raise ActionRuntimeError("APPROVAL_NOT_FOUND", "approval not found")
        return approval

    def _require_diff(self, diff_id: str) -> DiffRecord:
        if not isinstance(diff_id, str) or not diff_id:
            raise ActionRuntimeError("INVALID_PARAMS", "diff_id must be a non-empty string")
        record = self._diffs.get(diff_id)
        if record is None:
            if diff_id in self._recovered_actions:
                raise ActionRuntimeError(
                    "PAYLOAD_UNAVAILABLE",
                    "diff content is intentionally unavailable after process restart",
                )
            raise ActionRuntimeError("DIFF_NOT_FOUND", "diff not found")
        return record

    def _require_tool_action(self, action_id: str) -> ToolActionRecord:
        if not isinstance(action_id, str) or not action_id:
            raise ActionRuntimeError("INVALID_PARAMS", "action_id must be a non-empty string")
        record = self._tools.get(action_id)
        if record is None:
            if action_id in self._recovered_actions:
                raise ActionRuntimeError(
                    "PAYLOAD_UNAVAILABLE",
                    "tool arguments are intentionally unavailable after process restart",
                )
            raise ActionRuntimeError("TOOL_ACTION_NOT_FOUND", "tool action not found")
        return record

    @staticmethod
    def _validate_tool_arguments(definition: Any, arguments: dict[str, Any]) -> None:
        schemas = {param.name: param for param in definition.schema.params}
        unexpected = sorted(set(arguments) - set(schemas))
        if unexpected:
            raise ActionRuntimeError("INVALID_PARAMS", f"unexpected tool arguments: {', '.join(unexpected)}")
        missing = sorted(
            name
            for name, schema in schemas.items()
            if schema.required and name not in arguments and schema.default is None
        )
        if missing:
            raise ActionRuntimeError("INVALID_PARAMS", f"missing tool arguments: {', '.join(missing)}")
        expected_types = {
            "string": str,
            "path": str,
            "int": int,
            "float": (int, float),
            "bool": bool,
        }
        for name, value in arguments.items():
            expected = expected_types.get(schemas[name].type)
            if expected is not None and (not isinstance(value, expected) or isinstance(value, bool) and schemas[name].type in {"int", "float"}):
                raise ActionRuntimeError("INVALID_PARAMS", f"tool argument {name} has the wrong type")

    @staticmethod
    def _assert_session(requested: str, actual: str) -> None:
        if not isinstance(requested, str) or not requested:
            raise ActionRuntimeError("INVALID_PARAMS", "session_id must be a non-empty string")
        if requested != actual:
            raise ActionRuntimeError("SESSION_MISMATCH", "record belongs to another session")

    def _emit(self, event_type: str, session_id: str, data: dict[str, Any]) -> None:
        self._sequence += 1
        self._emit_callback(
            {
                "event_id": str(uuid.uuid4()),
                "session_id": session_id,
                "sequence": self._sequence,
                "timestamp": _format_time(_utc_now()),
                "type": event_type,
                "data": data,
            }
        )

    @staticmethod
    def _audit(event: str, record: DiffRecord) -> None:
        write_log("info", f"{event} diff_id={record.diff_id} path={record.relative_path}")

    @staticmethod
    def _audit_approval(event: str, approval: ApprovalRecord) -> None:
        write_log(
            "info",
            f"{event} approval_id={approval.approval_id} action={approval.action_type} status={approval.status}",
        )

    @staticmethod
    def _audit_tool(event: str, record: ToolActionRecord) -> None:
        write_log("info", f"{event} action_id={record.action_id} tool={record.tool_name} status={record.status}")

    def _persist_approval(self, approval: ApprovalRecord) -> None:
        if self._store is not None:
            self._store.save_approval(approval.public())

    def _persist_diff(self, record: DiffRecord) -> None:
        if self._store is not None:
            approval = self._approvals.get(record.approval_id)
            self._store.save_action(
                {
                    "record_id": record.diff_id,
                    "session_id": record.session_id,
                    "kind": "diff",
                    "status": record.status,
                    "label": record.relative_path,
                    "risk": approval.risk if approval else "high",
                    "created_at": _format_time(record.created_at),
                    "approval_id": record.approval_id,
                    "rollback_approval_id": record.rollback_approval_id or None,
                    "original_hash": record.original_hash,
                    "new_hash": record.new_hash,
                    "error": record.error or None,
                }
            )

    def _persist_tool(self, record: ToolActionRecord) -> None:
        if self._store is not None:
            self._store.save_action(
                {
                    "record_id": record.action_id,
                    "session_id": record.session_id,
                    "kind": "tool",
                    "status": record.status,
                    "label": record.tool_name,
                    "risk": record.risk,
                    "created_at": _format_time(record.created_at),
                    "approval_id": record.approval_id,
                    "error": None,
                }
            )

    @staticmethod
    def _public_recovered_action(record: dict[str, Any]) -> dict[str, Any]:
        return {
            key: record.get(key)
            for key in (
                "record_id",
                "session_id",
                "kind",
                "status",
                "label",
                "risk",
                "created_at",
                "updated_at",
                "approval_id",
                "rollback_approval_id",
                "error",
                "recovered",
                "payload_available",
            )
        }

    def _public_recovered_diff(self, record: dict[str, Any]) -> dict[str, Any]:
        return {
            "diff_id": record["record_id"],
            "session_id": record["session_id"],
            "file_path": record["label"],
            "status": record["status"],
            "created_at": record["created_at"],
            "original_hash": record.get("original_hash"),
            "new_hash": record.get("new_hash"),
            "unified_diff": None,
            "stats": None,
            "approval_id": record["approval_id"],
            "rollback_approval_id": record.get("rollback_approval_id"),
            "error": record.get("error"),
            "recovered": True,
            "payload_available": False,
        }

    @staticmethod
    def _public_file_history_live(record: DiffRecord) -> dict[str, Any]:
        return {
            "revision_id": record.diff_id,
            "file_path": record.relative_path,
            "status": record.status,
            "created_at": _format_time(record.created_at),
            "original_hash": record.original_hash,
            "new_hash": record.new_hash,
            "stats": record.stats,
            "approval_id": record.approval_id,
            "rollback_approval_id": record.rollback_approval_id or None,
            "error": record.error or None,
            "recovered": False,
            "payload_available": True,
        }

    @staticmethod
    def _public_file_history_recovered(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "revision_id": record["record_id"],
            "file_path": record["label"],
            "status": record["status"],
            "created_at": record["created_at"],
            "original_hash": record.get("original_hash"),
            "new_hash": record.get("new_hash"),
            "stats": None,
            "approval_id": record["approval_id"],
            "rollback_approval_id": record.get("rollback_approval_id"),
            "error": record.get("error"),
            "recovered": True,
            "payload_available": False,
        }

    def _public_recovered_tool(self, record: dict[str, Any]) -> dict[str, Any]:
        return {
            "action_id": record["record_id"],
            "session_id": record["session_id"],
            "tool_name": record["label"],
            "arguments": None,
            "risk": record["risk"],
            "status": record["status"],
            "created_at": record["created_at"],
            "approval_id": record["approval_id"],
            "result": None,
            "recovered": True,
            "payload_available": False,
        }

    @staticmethod
    def _public_live_diff(record: DiffRecord) -> dict[str, Any]:
        return {
            "record_id": record.diff_id,
            "session_id": record.session_id,
            "kind": "diff",
            "status": record.status,
            "label": record.relative_path,
            "risk": "high",
            "created_at": _format_time(record.created_at),
            "approval_id": record.approval_id,
            "rollback_approval_id": record.rollback_approval_id or None,
            "error": record.error or None,
            "recovered": False,
            "payload_available": True,
        }

    @staticmethod
    def _public_live_tool(record: ToolActionRecord) -> dict[str, Any]:
        return {
            "record_id": record.action_id,
            "session_id": record.session_id,
            "kind": "tool",
            "status": record.status,
            "label": record.tool_name,
            "risk": record.risk,
            "created_at": _format_time(record.created_at),
            "approval_id": record.approval_id,
            "rollback_approval_id": None,
            "error": (record.result or {}).get("error") or None,
            "recovered": False,
            "payload_available": True,
        }

    def _prune(self) -> None:
        if len(self._diffs) >= self._max_records:
            terminal = {
                key
                for key, value in self._diffs.items()
                if value.status in {"rejected", "rolled_back", "failed", "conflicted"}
            }
            for key in list(self._diffs):
                if key in terminal and len(self._diffs) >= self._max_records:
                    self._diffs.pop(key, None)
        referenced = {value.approval_id for value in self._diffs.values()}
        referenced.update(value.rollback_approval_id for value in self._diffs.values())
        referenced.update(value.approval_id for value in self._tools.values())
        if len(self._tools) >= self._max_records:
            for key, record in list(self._tools.items()):
                if record.status in {"rejected", "succeeded", "failed"}:
                    self._tools.pop(key, None)
                    if len(self._tools) < self._max_records:
                        break
        if len(self._approvals) >= self._max_records * 2:
            for key, approval in list(self._approvals.items()):
                if key not in referenced and approval.status in {"rejected", "expired", "consumed"}:
                    self._approvals.pop(key, None)
                    if len(self._approvals) < self._max_records * 2:
                        break
