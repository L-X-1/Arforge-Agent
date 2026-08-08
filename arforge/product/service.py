"""Canonical read-only product data exposed to every user interface."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any, Callable



_SAFE_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
_SAFE_WORKTREE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _optional_string(value: Any, field: str, *, max_len: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    cleaned = value.strip()
    if len(cleaned) > max_len:
        raise ValueError(f"{field} must be at most {max_len} characters")
    return cleaned


def _provided_string(params: dict[str, Any], field: str, *, max_len: int, allow_empty: bool = False) -> str | None:
    if field not in params:
        return None
    value = params[field]
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    cleaned = value.strip()
    if not allow_empty and not cleaned:
        raise ValueError(f"{field} must not be empty")
    if len(cleaned) > max_len:
        raise ValueError(f"{field} must be at most {max_len} characters")
    return cleaned


def _optional_int(value: Any, field: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be an integer") from None
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}")
    return parsed


def _required_positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a positive integer") from None
    if parsed < 1:
        raise ValueError(f"{field} must be a positive integer")
    return parsed


def _required_id_list(value: Any, field: str, *, maximum: int) -> list[int]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    if not value:
        raise ValueError(f"{field} must not be empty")
    if len(value) > maximum:
        raise ValueError(f"{field} must include at most {maximum} items")
    ids: list[int] = []
    seen: set[int] = set()
    for raw_id in value:
        if isinstance(raw_id, bool):
            raise ValueError(f"{field} entries must be positive integers")
        try:
            parsed = int(raw_id)
        except (TypeError, ValueError):
            raise ValueError(f"{field} entries must be positive integers") from None
        if parsed < 1:
            raise ValueError(f"{field} entries must be positive integers")
        if parsed not in seen:
            ids.append(parsed)
            seen.add(parsed)
    return ids


def _optional_id_list(value: Any, field: str, *, maximum: int) -> list[int]:
    if value is None:
        return []
    if value == []:
        return []
    return _required_id_list(value, field, maximum=maximum)


def _optional_string_list(value: Any, field: str, *, maximum: int, max_len: int) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    if len(value) > maximum:
        raise ValueError(f"{field} must include at most {maximum} items")
    items: list[str] = []
    seen: set[str] = set()
    for raw_item in value:
        if not isinstance(raw_item, str):
            raise ValueError(f"{field} entries must be strings")
        item = raw_item.strip()
        if not item:
            continue
        if len(item) > max_len:
            raise ValueError(f"{field} entries must be at most {max_len} characters")
        if item not in seen:
            seen.add(item)
            items.append(item)
    return items


class ProductService:
    """Return structured backend facts without terminal formatting or ANSI."""














    def feature_flag_set(self, params: dict[str, Any]) -> dict[str, Any]:
        flag_id = _provided_string(params, "flag_id", max_len=64)
        enabled = params.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be a boolean")
        from arforge.feature_flags import FeatureFlagError, get_feature_flags

        try:
            return get_feature_flags().set_override(flag_id or "", enabled)
        except FeatureFlagError as exc:
            raise ValueError(str(exc)) from None

    def feature_flag_clear(self, params: dict[str, Any]) -> dict[str, Any]:
        flag_id = _provided_string(params, "flag_id", max_len=64)
        from arforge.feature_flags import FeatureFlagError, get_feature_flags

        try:
            return get_feature_flags().clear_override(flag_id or "")
        except FeatureFlagError as exc:
            raise ValueError(str(exc)) from None

    def feature_flag_refresh(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.feature_flags import FeatureFlagError, get_feature_flags

        try:
            return get_feature_flags().refresh_remote_config()
        except FeatureFlagError as exc:
            raise ValueError(str(exc)) from None







    def permission_rules(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.permission_profile import list_rules

        return list_rules()


    def permission_rule_add(self, params: dict[str, Any]) -> dict[str, Any]:
        from arforge.permission_profile import add_rule, list_rules

        subject = _provided_string(params, "subject", max_len=192)
        category = _provided_string(params, "category", max_len=192)
        decision = _provided_string(params, "decision", max_len=32)
        scope = _optional_string(params.get("scope", "workspace"), "scope", max_len=192) or "workspace"
        reason = _optional_string(params.get("reason"), "reason", max_len=500)
        ttl_raw = params.get("ttl_seconds")
        ttl_seconds = None
        if ttl_raw is not None:
            ttl_seconds = _optional_int(ttl_raw, "ttl_seconds", minimum=1, maximum=86_400)
        rule = add_rule(
            subject=subject or "",
            category=category or "",
            scope=scope,
            decision=decision or "",
            reason=reason,
            ttl_seconds=ttl_seconds,
        )
        return {"schema_version": 1, "rule": rule.to_dict() | {"active": rule.active}, "rules": list_rules()}

    def permission_rule_revoke(self, params: dict[str, Any]) -> dict[str, Any]:
        from arforge.permission_profile import revoke_rule

        rule_id = _provided_string(params, "rule_id", max_len=128)
        rule = revoke_rule(rule_id or "")
        return {
            "schema_version": 1,
            "rule_id": rule_id,
            "revoked": rule is not None,
            "rule": None if rule is None else rule.to_dict() | {"active": rule.active},
        }

    def permission_mode_get(self, _params: dict[str, Any]) -> dict[str, Any]:
        from arforge.core.permission import PermissionMode, get_permission_manager, install_permission_hooks

        manager = get_permission_manager()
        mode = manager.get_mode()
        if mode is None:
            # Keep routine project work flowing by default. Workspace-local edits
            # and commands run in the background, while network, system and
            # dangerous actions still require an explicit decision.
            manager.set_mode(PermissionMode.AUTO_APPROVE)
            install_permission_hooks(manager.get_mode())
            mode = manager.get_mode()
        mode_value = mode.value if isinstance(mode, PermissionMode) else mode
        return {"mode": mode_value}

    def permission_mode_set(self, params: dict[str, Any]) -> dict[str, Any]:
        from arforge.core.permission import (
            PermissionMode,
            get_permission_manager,
            install_permission_hooks,
        )

        mode = params.get("mode")
        manager = get_permission_manager()
        # Normalize null/empty → deactivate (mode=None, allow everything).
        if mode is None or mode == "":
            manager.set_mode(None)
            return {"mode": None}
        if mode not in {m.value for m in PermissionMode}:
            raise ValueError(f"unknown permission mode: {mode}")
        manager.set_mode(mode)
        install_permission_hooks(manager.get_mode())
        current = manager.get_mode()
        return {"mode": current.value if isinstance(current, PermissionMode) else current}









    def memory_actual_recall_quality(self, params: dict[str, Any]) -> dict[str, Any]:
        """Return quality measured from real scoped retrieval events and feedback."""
        project_id = _optional_string(params.get("project_id"), "project_id", max_len=120)
        workspace_path = _optional_string(params.get("workspace_path"), "workspace_path", max_len=500)
        from arforge.memory_os import MemoryOS, memory_scope_id

        scope_id = memory_scope_id(project_id, workspace_path) if project_id or workspace_path else None
        return MemoryOS().recall_quality(scope_id=scope_id)

    def memory_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        """Delete one local memory through an explicit user action."""
        raw_id = params.get("memory_id")
        if isinstance(raw_id, bool):
            raise ValueError("memory_id must be a positive integer")
        try:
            memory_id = int(raw_id)
        except (TypeError, ValueError):
            raise ValueError("memory_id must be a positive integer") from None
        if memory_id < 1:
            raise ValueError("memory_id must be a positive integer")

        from arforge.core.memory_digest import refresh_digest_file
        from arforge.memory import delete_memory

        deleted = delete_memory(memory_id)
        if deleted:
            refresh_digest_file(force=True)
        return {
            "schema_version": 1,
            "memory_id": memory_id,
            "deleted": deleted,
            "status": "deleted" if deleted else "not_found",
        }

    def memory_bulk_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        """Delete explicit local memory IDs through an explicit user action."""
        memory_ids = _required_id_list(params.get("memory_ids"), "memory_ids", maximum=50)

        from arforge.memory import delete_memories

        result = delete_memories(memory_ids)
        return {
            "schema_version": 1,
            "requested": result["requested"],
            "deleted": len(result["deleted"]),
            "not_found": len(result["not_found"]),
            "deleted_ids": result["deleted"],
            "not_found_ids": result["not_found"],
            "status": "deleted" if result["deleted"] else "not_found",
        }

    def memory_update(self, params: dict[str, Any]) -> dict[str, Any]:
        """Edit one local memory through an explicit user action."""
        raw_id = params.get("memory_id")
        if isinstance(raw_id, bool):
            raise ValueError("memory_id must be a positive integer")
        try:
            memory_id = int(raw_id)
        except (TypeError, ValueError):
            raise ValueError("memory_id must be a positive integer") from None
        if memory_id < 1:
            raise ValueError("memory_id must be a positive integer")

        content = _provided_string(params, "content", max_len=4000)
        mem_type = _provided_string(params, "mem_type", max_len=50)
        tags = _provided_string(params, "tags", max_len=300, allow_empty=True)
        source = _provided_string(params, "source", max_len=50)
        importance = (
            _optional_int(params["importance"], "importance", minimum=0, maximum=5)
            if "importance" in params
            else None
        )
        if content is None and mem_type is None and tags is None and source is None and importance is None:
            raise ValueError("at least one editable memory field is required")

        from arforge.memory import update_memory_fields

        item = update_memory_fields(
            memory_id,
            content=content,
            mem_type=mem_type,
            tags=tags,
            importance=importance,
            source=source,
        )
        return {
            "schema_version": 1,
            "memory_id": memory_id,
            "updated": item is not None,
            "status": "updated" if item is not None else "not_found",
            "item": item,
        }


    def learning_undo(self, params: dict[str, Any]) -> dict[str, Any]:
        """Delete one recorded learning outcome through an explicit user action."""
        raw_id = params.get("learning_id")
        if isinstance(raw_id, bool):
            raise ValueError("learning_id must be a positive integer")
        try:
            learning_id = int(raw_id)
        except (TypeError, ValueError):
            raise ValueError("learning_id must be a positive integer") from None
        if learning_id < 1:
            raise ValueError("learning_id must be a positive integer")

        from arforge.learning_system import get_learning_system

        result = get_learning_system().delete_outcome_with_related(learning_id)
        deleted = bool(result["deleted"])
        return {
            "schema_version": 1,
            "learning_id": learning_id,
            "deleted": deleted,
            "status": "deleted" if deleted else "not_found",
            "linked_patterns": result["linked_patterns"],
        }

    def learning_dogfood_sync(self, params: dict[str, Any]) -> dict[str, Any]:
        """Explicitly import append-only dogfood outcomes into learning records."""
        limit = _optional_int(params.get("limit", 200), "limit", minimum=1, maximum=1000)
        from arforge.core.dogfood import sync_to_learning

        return sync_to_learning(limit=limit)




    def run_trace_import(self, params: dict[str, Any]) -> dict[str, Any]:
        """Import a validated portable trace without executing or reverting it."""

        content = _optional_string(
            params.get("content"),
            "content",
            max_len=5 * 1024 * 1024,
        )
        if not content:
            raise ValueError("content must not be empty")
        from arforge.core.run_transaction import import_run_trace

        return import_run_trace(content)

    def run_revert(self, params: dict[str, Any]) -> dict[str, Any]:
        """Revert a persisted agentic run transaction."""
        run_id = _optional_string(params.get("run_id"), "run_id", max_len=120)
        if not run_id:
            raise ValueError("run_id must not be empty")
        from arforge.core.run_transaction import revert_run

        try:
            restored, deleted, skipped = revert_run(run_id)
        except FileNotFoundError:
            return {
                "schema_version": 1,
                "run_id": run_id,
                "reverted": False,
                "status": "not_found",
                "restored": 0,
                "deleted": 0,
                "skipped": 0,
            }
        return {
            "schema_version": 1,
            "run_id": run_id,
            "reverted": True,
            "status": "reverted",
            "restored": restored,
            "deleted": deleted,
            "skipped": skipped,
        }




    def workspace(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return the canonical workspace root used by path-confined actions."""
        root = Path.cwd().resolve()
        return {"root": str(root), "exists": root.is_dir(), "writable": os.access(root, os.W_OK)}



    def git_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Return the current Git branch surface for the desktop branch picker."""
        root = Path.cwd().resolve()
        top = _git(["rev-parse", "--show-toplevel"], root, allow_error=True)
        if top.returncode != 0:
            return {
                "available": False,
                "root": str(root),
                "current_branch": None,
                "branches": [],
                "modified_count": 0,
                "untracked_count": 0,
                "clean": True,
                "detached": False,
                "issue": "workspace is not a git repository",
            }

        branch_result = _git(["branch", "--show-current"], root, allow_error=True)
        current = branch_result.stdout.strip()
        detached = current == ""
        if detached:
            head = _git(["rev-parse", "--short", "HEAD"], root, allow_error=True).stdout.strip()
            current = head or "DETACHED"

        branches_result = _git(
            ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
            root,
            allow_error=True,
        )
        branch_names = [line.strip() for line in branches_result.stdout.splitlines() if line.strip()]
        if current and not detached and current not in branch_names:
            branch_names.append(current)
        status_result = _git(["status", "--porcelain=v1"], root, allow_error=True)
        modified_count = 0
        untracked_count = 0
        for line in status_result.stdout.splitlines():
            if line.startswith("??"):
                untracked_count += 1
            elif line.strip():
                modified_count += 1

        return {
            "available": True,
            "root": top.stdout.strip() or str(root),
            "current_branch": current,
            "branches": [
                {"name": name, "is_current": name == current}
                for name in sorted(branch_names, key=str.casefold)
            ],
            "modified_count": modified_count,
            "untracked_count": untracked_count,
            "clean": modified_count == 0 and untracked_count == 0,
            "detached": detached,
            "issue": None,
        }

    def git_checkout(self, params: dict[str, Any]) -> dict[str, Any]:
        """Checkout an existing branch or create a new branch with strict validation."""
        branch = str(params.get("branch", "")).strip()
        create = bool(params.get("create", False))
        if not _valid_branch_name(branch):
            raise ValueError("invalid branch name")

        status = self.git_status({})
        if not status["available"]:
            raise ValueError(str(status["issue"]))
        if branch == status["current_branch"]:
            return status
        if not create and not status["clean"]:
            raise ValueError("commit or stash local changes before switching branches")

        root = Path(str(status["root"]))
        args = ["switch", "-c", branch] if create else ["switch", branch]
        result = _git(args, root, allow_error=True)
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "git switch failed").strip()
            raise ValueError(message)
        return self.git_status({})

    def git_worktree_create(self, params: dict[str, Any]) -> dict[str, Any]:
        """Create an isolated Git worktree with a new branch in a controlled path."""
        branch = _provided_string(params, "branch", max_len=128)
        if not _valid_branch_name(branch or ""):
            raise ValueError("invalid branch name")
        requested_name = _provided_string(params, "name", max_len=64)
        name = requested_name or re.sub(r"[^A-Za-z0-9._-]+", "-", branch or "")
        if not _SAFE_WORKTREE_NAME.fullmatch(name):
            raise ValueError("invalid worktree name")
        status = self.git_status({})
        if not status["available"]:
            raise ValueError(str(status["issue"]))
        if not status["clean"]:
            raise ValueError("commit or stash local changes before creating a worktree")
        root = Path(str(status["root"])).resolve()
        target = (root.parent / ".arforge-worktrees" / name).resolve()
        if target.exists():
            raise ValueError("worktree destination already exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        result = _git(["worktree", "add", "-b", branch or "", str(target)], root, allow_error=True)
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "git worktree creation failed").strip()
            raise ValueError(message)
        return {"root": str(target), "branch": branch, "name": name, "created": True}

    def git_worktree_prepare_remove(self, _params: dict[str, Any]) -> dict[str, Any]:
        """Validate the active managed worktree before the desktop leaves it."""
        status = self.git_status({})
        if not status["available"]:
            raise ValueError(str(status["issue"]))
        if not status["clean"]:
            raise ValueError("commit or stash local changes before removing the worktree")

        target = Path(str(status["root"])).resolve()
        common = _git(
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            target,
            allow_error=True,
        )
        if common.returncode != 0:
            message = (common.stderr or common.stdout or "unable to resolve worktree owner").strip()
            raise ValueError(message)
        common_dir = Path(common.stdout.strip()).resolve()
        primary_root = common_dir.parent
        if target == primary_root:
            raise ValueError("the primary worktree cannot be removed")
        managed_root = (primary_root.parent / ".arforge-worktrees").resolve()
        if not target.is_relative_to(managed_root):
            raise ValueError("refusing to remove a worktree outside the managed directory")

        return {
            "root": str(primary_root),
            "removed_root": str(target),
            "branch": status["current_branch"],
            "ready": True,
        }

    def git_worktree_remove(self, params: dict[str, Any]) -> dict[str, Any]:
        """Remove a managed worktree after the desktop has switched to its owner."""
        target_value = _provided_string(params, "root", max_len=4096)
        if not target_value:
            raise ValueError("root is required")
        status = self.git_status({})
        if not status["available"]:
            raise ValueError(str(status["issue"]))
        primary_root = Path(str(status["root"])).resolve()
        target = Path(target_value).resolve()
        managed_root = (primary_root.parent / ".arforge-worktrees").resolve()
        if not target.is_relative_to(managed_root) or target == managed_root:
            raise ValueError("refusing to remove a worktree outside the managed directory")
        if not target.is_dir():
            raise ValueError("managed worktree no longer exists")
        target_status = _git(["status", "--porcelain=v1"], target, allow_error=True)
        if target_status.returncode != 0:
            message = (target_status.stderr or target_status.stdout or "unable to inspect worktree").strip()
            raise ValueError(message)
        if target_status.stdout.strip():
            raise ValueError("commit or stash local changes before removing the worktree")
        branch = _git(["branch", "--show-current"], target, allow_error=True).stdout.strip() or None
        result = _git(["worktree", "remove", str(target)], primary_root, allow_error=True)
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "git worktree removal failed").strip()
            raise ValueError(message)
        return {
            "root": str(primary_root),
            "removed_root": str(target),
            "branch": branch,
            "removed": True,
        }

    def methods(self) -> dict[str, Callable[[dict[str, Any]], dict[str, Any]]]:
        return {
            "features.set": self.feature_flag_set,
            "features.clear": self.feature_flag_clear,
            "features.refresh": self.feature_flag_refresh,
            "permissions.rule.add": self.permission_rule_add,
            "permissions.rule.revoke": self.permission_rule_revoke,
            "permissions.mode.set": self.permission_mode_set,
            "memory.actual_recall_quality": self.memory_actual_recall_quality,
            "memory.delete": self.memory_delete,
            "memory.bulk_delete": self.memory_bulk_delete,
            "memory.update": self.memory_update,
            "learning.undo": self.learning_undo,
            "learning.dogfood_sync": self.learning_dogfood_sync,
            "run.trace.import": self.run_trace_import,
            "run.revert": self.run_revert,
            "git.checkout": self.git_checkout,
            "git.worktree.create": self.git_worktree_create,
            "git.worktree.prepare_remove": self.git_worktree_prepare_remove,
            "git.worktree.remove": self.git_worktree_remove,
        }


def _git(
    args: list[str],
    cwd: Path,
    *,
    allow_error: bool = False,
    timeout: int = 8,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["GIT_CEILING_DIRECTORIES"] = str(cwd.parent)
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0 and not allow_error:
        raise RuntimeError(result.stderr.strip() or "git command failed")
    return result


def _valid_branch_name(value: str) -> bool:
    if not _SAFE_BRANCH.match(value):
        return False
    invalid = ("..", "@{", "\\", "//")
    return not any(part in value for part in invalid) and not value.endswith(("/", ".", ".lock"))


def _resolve_workspace_path(root: Path, value: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute():
        raise ValueError("absolute paths are not allowed")
    resolved = (root / candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("path escapes workspace")
    return resolved
