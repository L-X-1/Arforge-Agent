"""Versioned JSONL bridge for desktop and other machine clients."""

from __future__ import annotations

import json
import os
import runpy
import secrets
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from arforge.product.action_runtime import ActionRuntime, ActionRuntimeError
from arforge.feature_flags import get_feature_flags
from arforge.product.feedback_runtime import FeedbackRuntime, FeedbackRuntimeError
from arforge.product.goal_runtime import GoalRuntime, GoalRuntimeError
from arforge.product.log_runtime import LogRuntime, LogRuntimeError
from arforge.product.model_config_runtime import ModelConfigError
from arforge.product.keybinding_runtime import KeybindingRuntime, KeybindingRuntimeError
from arforge.product.service import ProductService
from arforge.product.session_runtime import (
    DEFAULT_TIMEOUT_MS,
    SessionRuntime,
    SessionRuntimeError,
)
from arforge.product.state_store import BridgeStateStore
from arforge.product.settings_runtime import SettingsRuntime, SettingsRuntimeError
from arforge.product.task_runtime import TaskRuntime, TaskRuntimeError, TaskStore
from arforge.paths import data_path
from arforge.database.sqlite_runtime import ProfileLockError
from arforge.security_guard import sanitize_log_message

PROTOCOL = "arforge.bridge"
PROTOCOL_VERSION = "1.2"
SUPPORTED_VERSIONS = {"1.0", "1.1", "1.2"}
MAX_REQUEST_BYTES = 1024 * 1024
_FROZEN_SCRIPT_MODE = "--arforge-run-python-script"
_FROZEN_SCRIPT_TOKEN_ENV = "ARFORGE_INTERNAL_SCRIPT_TOKEN"
_FROZEN_SCRIPT_WORKSPACE_ENV = "ARFORGE_INTERNAL_SCRIPT_WORKSPACE"


def _run_frozen_script_mode(argv: list[str] | None = None) -> int | None:
    """Execute a validated temporary Python script for the frozen Sidecar."""
    args = list(sys.argv if argv is None else argv)
    if len(args) < 2 or args[1] != _FROZEN_SCRIPT_MODE:
        return None
    if len(args) != 4:
        print("invalid internal script invocation", file=sys.stderr)
        return 126
    expected = os.environ.pop(_FROZEN_SCRIPT_TOKEN_ENV, "")
    supplied = args[2]
    if not expected or not secrets.compare_digest(expected, supplied):
        print("invalid internal script token", file=sys.stderr)
        return 126
    script = Path(args[3]).resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if (
        script.parent != temp_root
        or not script.name.startswith("arforge-validation-")
        or script.suffix.casefold() != ".py"
        or not script.is_file()
    ):
        print("invalid internal script path", file=sys.stderr)
        return 126
    workspace = os.environ.pop(_FROZEN_SCRIPT_WORKSPACE_ENV, "").strip()
    if workspace:
        resolved_workspace = str(Path(workspace).resolve())
        if resolved_workspace not in sys.path:
            sys.path.insert(0, resolved_workspace)
    sys.argv = [str(script)]
    runpy.run_path(str(script), run_name="__main__")
    return 0

READ_ONLY_METHODS = {
    "health",
    "status.get",
    "tools.list",
    "agents.list",
    "subagents.roles",
    "capabilities.list",
    "skills.list",
    "skills.read",
    "skills.route",
    "features.list",
    "customizations.render",
    "customizations.list",
    "file_state.list",
    "cost.optimization",
    "repo.scale",
    "quality.assess",
    "permissions.rules",
    "sandbox.status",
    "permissions.mode.get",
    "config.get",
    "memory.status",
    "memory.search",
    "memory.facets",
    "memory.governance.preview",
    "memory.semantic_search",
    "memory.recall_quality",
    "learning.status",
    "self_correct.eval",
    "runtime.stats",
    "runtime.metrics",
    "workflows.list",
    "workflows.preview",
    "workflow.graph.list",
    "workflow.graph.get",
    "workflow.graph.events",
    "plan.preview",
    "run.list",
    "run.report",
    "run.trace.export",
    "release.gates",
    "release.remediation_plan",
    "multimodal.diagnose",
    "workspace.get",
    "git.status",
    "git.diff",
}
SESSION_METHODS = {
    "project.list",
    "session.create",
    "session.fork",
    "session.get",
    "session.rename",
    "session.tags.update",
    "session.list",
    "session.messages",
    "session.export",
    "session.import",
    "session.context.import",
    "session.compact",
    "session.archive",
    "session.resume",
    "session.close",
    "session.checkpoint.create",
    "session.checkpoint.list",
    "session.rewind.preview",
    "session.rewind.apply",
    "schedule.create",
    "schedule.list",
    "schedule.delete",
    "schedule.run_missed",
    "trigger.profiles",
    "trigger.list",
    "trigger.get",
    "trigger.create",
    "trigger.update",
    "trigger.run",
    "wait.active",
    "wait.wake",
    "team.create",
    "team.get",
    "team.delete",
    "team.member.add",
    "team.member.remove",
    "team.message.send",
    "team.message.list",
    "team.shutdown.request",
    "chat.start",
    "chat.resume",
    "chat.enqueue",
    "chat.queue.list",
    "chat.queue.delete",
    "chat.side.ask",
    "chat.side.get",
    "chat.side.list",
    "chat.side.cancel",
    "chat.steer",
    "chat.cancel",
    "operation.get",
    "question.get",
    "question.respond",
    "question.reject",
    "history.search",
}
ACTION_METHODS = {
    "action.list",
    "file.history",
    "approval.get",
    "approval.respond",
    "diff.preview",
    "diff.get",
    "diff.reject",
    "diff.apply",
    "diff.rollback",
    "tool.prepare",
    "tool.get",
    "tool.reject",
    "tool.execute",
    "tool.execute_async",
    "file.write.preview",
    "file.write.get",
    "file.write.reject",
    "file.write.apply",
}
TASK_METHODS = {"task.get", "task.list", "task.cancel", "task.retry"}
GOAL_METHODS = {
    "goal.create",
    "goal.list",
    "goal.get",
    "goal.run",
    "goal.pause",
    "goal.resume",
    "goal.replace",
    "goal.cancel",
    "goal.delete",
    "goal.reorder",
}
PRODUCT_METHODS = {"logs.query", "settings.get", "settings.update", "keybindings.get", "keybindings.update", "keybindings.reset", "feedback.summary", "feedback.list", "feedback.submit", "feedback.delete", "skills.enable", "skills.disable", "skills.refresh", "features.set", "features.clear", "features.refresh", "permissions.mode.set", "permissions.rule.add", "permissions.rule.revoke", "learning.undo", "learning.dogfood_sync", "memory.delete", "memory.bulk_delete", "memory.update", "memory.governance.apply", "run.revert", "run.trace.import", "workflow.graph.start", "workflow.graph.pause", "workflow.graph.resume", "workflow.graph.cancel", "workflow.graph.approve", "workflow.graph.retry", "model_config.list", "model_config.active", "model_config.set_key", "model_config.delete_key", "model_config.set_active", "model_config.set_model", "model_config.set_context_window", "model_config.set_base_url", "model_config.set_label", "plugins.list", "plugins.set_enabled", "plugins.install.inspect", "plugins.install.apply", "plugins.remove", "plugins.restore", "output_styles.list", "output_styles.read", "output_styles.set", "output_styles.clear", "themes.list", "custom_agents.list"}
GIT_METHODS = {"git.checkout", "git.worktree.create", "git.worktree.prepare_remove", "git.worktree.remove"}
CAPABILITY_MANAGEMENT_METHODS = {
    "plugins.list",
    "skills.enable",
    "skills.disable",
    "skills.refresh",
    "plugins.set_enabled",
    "plugins.install.inspect",
    "plugins.install.apply",
    "plugins.remove",
    "plugins.restore",
    "workflow.graph.start",
    "workflow.graph.pause",
    "workflow.graph.resume",
    "workflow.graph.cancel",
    "workflow.graph.approve",
    "workflow.graph.retry",
}
CAPABILITY_METHODS = {
    "protocol.describe",
    *READ_ONLY_METHODS,
    *CAPABILITY_MANAGEMENT_METHODS,
}


@dataclass(frozen=True)
class BridgeError(Exception):
    code: str
    message: str


def _envelope(
    request_id: Any,
    *,
    version: str = "1.0",
    data: Any = None,
    error: dict | None = None,
) -> dict:
    response = {
        "protocol": PROTOCOL,
        "version": version,
        "id": request_id,
        "ok": error is None,
    }
    response["data" if error is None else "error"] = data if error is None else error
    return response


def _register_builtin_tools() -> None:
    """Import the built-in tool modules so their ``@register_tool`` side-effects
    populate the global registry. Mirrors the import block in ``arforge code``
    (cli.py) so the agentic chat loop sees the same tool surface. Failures are
    swallowed per-module so an optional dependency cannot brick the bridge.
    """
    from arforge.tools import load_builtin_tools

    load_builtin_tools()


def _install_agentic_hooks() -> None:
    """Install the same run-loop infrastructure that ``arforge code`` uses.

    The desktop Bridge is a long-lived process, so every installer must be
    idempotent. Optional failures are swallowed per hook so one subsystem cannot
    prevent chat from starting.
    """
    installers = (
        ("arforge.core.compaction", "install_compaction_hook"),
        ("arforge.core.interrupt", "install_interrupt_hook"),
        ("arforge.core.change_tracker", "install_change_tracker_hook"),
        ("arforge.core.run_report", "install_run_report_hook"),
        ("arforge.core.run_transaction", "install_run_transaction_hook"),
        ("arforge.core.edit_verify", "install_edit_verify_hook"),
        ("arforge.core.self_correct", "install_self_correct_hook"),
        ("arforge.core.learning_hook", "install_learning_hooks"),
        ("arforge.core.memory_hook", "install_memory_hooks"),
        ("arforge.customization", "install_custom_hooks"),
    )
    import importlib

    for module_name, func_name in installers:
        try:
            module = importlib.import_module(module_name)
            getattr(module, func_name)()
        except Exception:  # noqa: BLE001 - hook install is best-effort in the bridge
            pass


def _describe(
    version: str,
    service: ProductService,
    *,
    capability_only: bool = False,
) -> dict[str, Any]:
    methods = ["protocol.describe", *READ_ONLY_METHODS]
    if version in ("1.1", "1.2"):
        methods.extend(SESSION_METHODS)
        methods.extend(GOAL_METHODS)
        methods.extend(ACTION_METHODS)
        methods.extend(TASK_METHODS)
        methods.extend(PRODUCT_METHODS)
        methods.extend(GIT_METHODS)
    mutating_methods = {
        "chat.enqueue",
        "chat.queue.delete",
        "chat.side.ask",
        "chat.side.cancel",
        "chat.steer",
        "diff.apply",
        "diff.rollback",
        "feedback.delete",
        "feedback.submit",
        "git.checkout",
        "git.worktree.create",
        "git.worktree.remove",
        "goal.cancel",
        "goal.create",
        "goal.delete",
        "goal.pause",
        "goal.reorder",
        "goal.replace",
        "goal.resume",
        "goal.run",
        "keybindings.reset",
        "keybindings.update",
        "learning.dogfood_sync",
        "learning.undo",
        "memory.bulk_delete",
        "memory.delete",
        "memory.governance.apply",
        "memory.update",
        "output_styles.clear",
        "output_styles.set",
        "plugins.install.apply",
        "plugins.install.inspect",
        "plugins.remove",
        "plugins.restore",
        "plugins.set_enabled",
        "model_config.delete_key",
        "model_config.set_active",
        "model_config.set_base_url",
        "model_config.set_context_window",
        "model_config.set_key",
        "model_config.set_label",
        "model_config.set_model",
        "permissions.mode.set",
        "permissions.rule.add",
        "permissions.rule.revoke",
        "question.reject",
        "question.respond",
        "run.revert",
        "run.trace.import",
        "schedule.create",
        "schedule.delete",
        "schedule.run_missed",
        "session.checkpoint.create",
        "session.archive",
        "session.import",
        "session.context.import",
        "session.compact",
        "session.rename",
        "session.rewind.apply",
        "session.tags.update",
        "settings.update",
        "skills.disable",
        "skills.enable",
        "skills.refresh",
        "team.create",
        "team.delete",
        "team.member.add",
        "team.member.remove",
        "team.message.send",
        "team.shutdown.request",
        "tool.execute",
        "tool.execute_async",
        "trigger.create",
        "trigger.run",
        "trigger.update",
        "wait.wake",
        "workflow.graph.approve",
        "workflow.graph.cancel",
        "workflow.graph.pause",
        "workflow.graph.resume",
        "workflow.graph.retry",
        "workflow.graph.start",
    }
    stateful_methods = (
        SESSION_METHODS
        | ACTION_METHODS
        | TASK_METHODS
        | GOAL_METHODS
        | PRODUCT_METHODS
        | GIT_METHODS
    )
    workspace_mutating_methods = {
        "diff.apply",
        "diff.rollback",
        "git.checkout",
        "git.worktree.create",
        "git.worktree.remove",
        "run.revert",
        "tool.execute",
        "tool.execute_async",
        "workflow.graph.approve",
        "workflow.graph.resume",
        "workflow.graph.retry",
        "workflow.graph.start",
    }
    if capability_only:
        methods = sorted(CAPABILITY_METHODS)
        mutating_methods &= CAPABILITY_MANAGEMENT_METHODS
        stateful_methods = set(CAPABILITY_MANAGEMENT_METHODS)
        workspace_mutating_methods &= CAPABILITY_MANAGEMENT_METHODS
    return {
        "protocol": PROTOCOL,
        "version": version,
        "supported_versions": sorted(SUPPORTED_VERSIONS),
        "methods": sorted(methods),
        "transport": "jsonl-stdio",
        "transport_backpressure": "blocking-write",
        "mutating_methods": sorted(mutating_methods) if version in ("1.1", "1.2") else [],
        "stateful_methods": sorted(stateful_methods)
        if version in ("1.1", "1.2")
        else [],
        "workspace_mutating_methods": sorted(workspace_mutating_methods)
        if version in ("1.1", "1.2")
        else [],
    }


def _require_only(params: dict[str, Any], allowed: set[str]) -> None:
    unexpected = sorted(set(params) - allowed)
    if unexpected:
        raise BridgeError("INVALID_PARAMS", f"unexpected parameters: {', '.join(unexpected)}")


def _team_call(runtime: SessionRuntime, session_id: Any, operation, *args, **kwargs) -> dict:
    runtime.get_session(session_id)
    try:
        return operation(session_id, *args, **kwargs)
    except Exception as exc:
        from arforge.team_runtime import TeamRuntimeError

        if isinstance(exc, TeamRuntimeError):
            raise BridgeError(exc.code, exc.message) from None
        raise


def _dispatch_session(
    method: str,
    params: dict[str, Any],
    runtime: SessionRuntime | None,
    actions: ActionRuntime | None = None,
    tasks: TaskRuntime | None = None,
    settings: SettingsRuntime | None = None,
) -> dict:
    if runtime is None:
        raise BridgeError("METHOD_NOT_AVAILABLE", "session runtime is not available")
    if method == "project.list":
        _require_only(params, set())
        return runtime.list_projects()
    if method == "session.create":
        _require_only(params, {"project_id"})
        return runtime.create_session(project_id=params.get("project_id"))
    if method == "session.fork":
        _require_only(params, {"session_id", "message_id"})
        return runtime.fork_session(params.get("session_id"), params.get("message_id"))
    if method == "session.get":
        _require_only(params, {"session_id"})
        return runtime.get_session(params.get("session_id"))
    if method == "session.rename":
        _require_only(params, {"session_id", "title"})
        return runtime.rename_session(params.get("session_id"), params.get("title"))
    if method == "session.tags.update":
        _require_only(params, {"session_id", "tags"})
        return runtime.update_session_tags(
            params.get("session_id"),
            params.get("tags"),
        )
    if method == "session.list":
        _require_only(params, {"limit", "project_id", "tags", "status", "query", "archive"})
        return runtime.filter_sessions(
            limit=params.get("limit", 50),
            project_id=params.get("project_id"),
            tags=params.get("tags"),
            status=params.get("status"),
            query=params.get("query"),
            archive=params.get("archive", "exclude"),
        )
    if method == "session.messages":
        _require_only(params, {"session_id", "limit"})
        return runtime.get_messages(params.get("session_id"), params.get("limit", 500))
    if method == "session.export":
        _require_only(params, {"session_id", "format"})
        if not get_feature_flags().enabled("session_export"):
            raise BridgeError("FEATURE_DISABLED", "session export is disabled by feature policy")
        return runtime.export_session(params.get("session_id"), params.get("format", "markdown"))
    if method == "session.import":
        _require_only(params, {"content"})
        if not get_feature_flags().enabled("session_export"):
            raise BridgeError("FEATURE_DISABLED", "session import is disabled by feature policy")
        return runtime.import_session(params.get("content"))
    if method == "session.context.import":
        _require_only(
            params,
            {"session_id", "content", "source", "source_session_id"},
        )
        return runtime.import_context(
            params.get("session_id"),
            content=params.get("content"),
            source=params.get("source"),
            source_session_id=params.get("source_session_id"),
        )
    if method == "session.compact":
        _require_only(params, {"session_id", "focus"})
        return runtime.compact_session(
            params.get("session_id"),
            params.get("focus", ""),
        )
    if method == "session.archive":
        _require_only(params, {"session_ids", "archived"})
        return runtime.set_sessions_archived(
            params.get("session_ids"),
            params.get("archived"),
        )
    if method == "session.resume":
        _require_only(params, {"session_id"})
        return runtime.resume_session(params.get("session_id"))
    if method == "session.close":
        _require_only(params, {"session_id"})
        if actions is not None and actions.has_open_actions(params.get("session_id")):
            raise BridgeError("SESSION_BUSY", "resolve pending approvals and diffs before closing")
        if tasks is not None and tasks.has_active_tasks(params.get("session_id")):
            raise BridgeError("SESSION_BUSY", "cancel active tasks before closing")
        from arforge.team_runtime import get_team_manager

        if get_team_manager().has_team(params.get("session_id")):
            raise BridgeError("SESSION_BUSY", "delete the session-owned team before closing")
        return runtime.close_session(params.get("session_id"))
    if method == "session.checkpoint.create":
        _require_only(params, {"session_id", "label"})
        return runtime.create_session_checkpoint(
            params.get("session_id"),
            params.get("label", ""),
        )
    if method == "session.checkpoint.list":
        _require_only(params, {"session_id", "limit"})
        return runtime.list_session_checkpoints(
            params.get("session_id"),
            params.get("limit", 50),
        )
    if method == "session.rewind.preview":
        _require_only(params, {"session_id", "checkpoint_id"})
        return runtime.preview_session_rewind(
            params.get("session_id"),
            params.get("checkpoint_id"),
        )
    if method == "session.rewind.apply":
        _require_only(
            params,
            {"session_id", "checkpoint_id", "expected_last_sequence"},
        )
        return runtime.apply_session_rewind(
            params.get("session_id"),
            params.get("checkpoint_id"),
            params.get("expected_last_sequence"),
        )
    if method == "schedule.create":
        _require_only(params, {"session_id", "cron", "prompt", "recurring", "durable"})
        return runtime.create_schedule(
            params.get("session_id"),
            params.get("cron"),
            params.get("prompt"),
            recurring=params.get("recurring", True),
            durable=params.get("durable", False),
        )
    if method == "schedule.list":
        _require_only(params, {"session_id"})
        return runtime.list_schedules(params.get("session_id"))
    if method == "schedule.delete":
        _require_only(params, {"session_id", "job_id"})
        return runtime.delete_schedule(params.get("session_id"), params.get("job_id"))
    if method == "schedule.run_missed":
        _require_only(params, {"session_id", "job_id", "timeout_ms"})
        return runtime.run_missed_schedule(
            params.get("session_id"),
            params.get("job_id"),
            params.get("timeout_ms", DEFAULT_TIMEOUT_MS),
        )
    if method == "trigger.profiles":
        _require_only(params, {"session_id"})
        return runtime.trigger_profiles(params.get("session_id"))
    if method == "trigger.list":
        _require_only(params, {"session_id", "profile"})
        return runtime.manage_trigger(
            params.get("session_id"),
            "list",
            profile=params.get("profile", "local"),
        )
    if method == "trigger.get":
        _require_only(params, {"session_id", "profile", "trigger_id"})
        return runtime.manage_trigger(
            params.get("session_id"),
            "get",
            profile=params.get("profile", "local"),
            trigger_id=params.get("trigger_id", ""),
        )
    if method == "trigger.create":
        _require_only(params, {"session_id", "profile", "body"})
        return runtime.manage_trigger(
            params.get("session_id"),
            "create",
            profile=params.get("profile", "local"),
            body=params.get("body"),
        )
    if method == "trigger.update":
        _require_only(params, {"session_id", "profile", "trigger_id", "body"})
        return runtime.manage_trigger(
            params.get("session_id"),
            "update",
            profile=params.get("profile", "local"),
            trigger_id=params.get("trigger_id", ""),
            body=params.get("body"),
        )
    if method == "trigger.run":
        _require_only(params, {"session_id", "profile", "trigger_id", "timeout_ms"})
        return runtime.manage_trigger(
            params.get("session_id"),
            "run",
            profile=params.get("profile", "local"),
            trigger_id=params.get("trigger_id", ""),
            timeout_ms=params.get("timeout_ms", DEFAULT_TIMEOUT_MS),
        )
    if method == "wait.active":
        _require_only(params, {"session_id"})
        return runtime.active_wait(params.get("session_id"))
    if method == "wait.wake":
        _require_only(params, {"session_id", "wait_id"})
        return runtime.wake_wait(
            params.get("session_id"),
            params.get("wait_id", ""),
        )
    if method == "team.create":
        _require_only(params, {"session_id", "name", "description"})
        from arforge.team_runtime import get_team_manager

        return _team_call(
            runtime,
            params.get("session_id"),
            get_team_manager().create,
            params.get("name"),
            params.get("description", ""),
        )
    if method == "team.get":
        _require_only(params, {"session_id"})
        from arforge.team_runtime import get_team_manager

        return _team_call(runtime, params.get("session_id"), get_team_manager().get)
    if method == "team.member.add":
        _require_only(params, {"session_id", "member_name", "role"})
        from arforge.team_runtime import get_team_manager

        return _team_call(
            runtime,
            params.get("session_id"),
            get_team_manager().add_member,
            params.get("member_name"),
            params.get("role"),
        )
    if method == "team.message.send":
        _require_only(params, {"session_id", "recipient", "message", "summary", "kind"})
        from arforge.team_runtime import get_team_manager

        return _team_call(
            runtime,
            params.get("session_id"),
            get_team_manager().send_message,
            params.get("recipient"),
            params.get("message"),
            summary=params.get("summary", ""),
            kind=params.get("kind", "info"),
        )
    if method == "team.message.list":
        _require_only(params, {"session_id", "after_sequence", "limit"})
        from arforge.team_runtime import get_team_manager

        return _team_call(
            runtime,
            params.get("session_id"),
            get_team_manager().list_messages,
            after_sequence=params.get("after_sequence", 0),
            limit=params.get("limit", 50),
        )
    if method == "team.shutdown.request":
        _require_only(params, {"session_id", "member_name", "reason"})
        from arforge.team_runtime import get_team_manager

        return _team_call(
            runtime,
            params.get("session_id"),
            get_team_manager().request_shutdown,
            params.get("member_name"),
            params.get("reason", ""),
        )
    if method == "team.member.remove":
        _require_only(params, {"session_id", "member_name"})
        from arforge.team_runtime import get_team_manager

        return _team_call(
            runtime,
            params.get("session_id"),
            get_team_manager().remove_member,
            params.get("member_name"),
        )
    if method == "team.delete":
        _require_only(params, {"session_id"})
        from arforge.team_runtime import get_team_manager

        return _team_call(runtime, params.get("session_id"), get_team_manager().delete)
    if method == "chat.start":
        _require_only(
            params,
            {
                "session_id",
                "input",
                "timeout_ms",
                "reasoning_effort",
                "permission_mode",
                "context",
            },
        )
        timeout_ms = params.get("timeout_ms")
        if timeout_ms is None:
            timeout_ms = settings.value("chat_timeout_ms") if settings is not None else DEFAULT_TIMEOUT_MS
        return runtime.start_chat(
            params.get("session_id"),
            params.get("input"),
            timeout_ms,
            reasoning_effort=params.get("reasoning_effort", "medium"),
            permission_mode=params.get("permission_mode"),
            context=params.get("context"),
        )
    if method == "chat.resume":
        _require_only(
            params,
            {
                "session_id",
                "timeout_ms",
                "reasoning_effort",
                "permission_mode",
                "context",
            },
        )
        timeout_ms = params.get("timeout_ms")
        if timeout_ms is None:
            timeout_ms = settings.value("chat_timeout_ms") if settings is not None else DEFAULT_TIMEOUT_MS
        return runtime.resume_incomplete_chat(
            params.get("session_id"),
            timeout_ms,
            reasoning_effort=params.get("reasoning_effort", "medium"),
            permission_mode=params.get("permission_mode"),
            context=params.get("context"),
        )
    if method == "chat.enqueue":
        _require_only(
            params,
            {
                "session_id",
                "input",
                "timeout_ms",
                "reasoning_effort",
                "permission_mode",
                "context",
            },
        )
        timeout_ms = params.get("timeout_ms")
        if timeout_ms is None:
            timeout_ms = settings.value("chat_timeout_ms") if settings is not None else DEFAULT_TIMEOUT_MS
        return runtime.enqueue_chat(
            params.get("session_id"),
            params.get("input"),
            timeout_ms,
            reasoning_effort=params.get("reasoning_effort", "medium"),
            permission_mode=params.get("permission_mode"),
            context=params.get("context"),
        )
    if method == "chat.queue.list":
        _require_only(params, {"session_id"})
        return runtime.list_queued_chats(params.get("session_id"))
    if method == "chat.queue.delete":
        _require_only(params, {"session_id", "queue_id"})
        return runtime.delete_queued_chat(
            params.get("session_id"),
            params.get("queue_id"),
        )
    if method == "chat.side.ask":
        _require_only(
            params,
            {"session_id", "question", "timeout_ms", "reasoning_effort"},
        )
        timeout_ms = params.get("timeout_ms")
        if timeout_ms is None:
            timeout_ms = (
                settings.value("chat_timeout_ms")
                if settings is not None
                else DEFAULT_TIMEOUT_MS
            )
        return runtime.start_side_question(
            params.get("session_id"),
            params.get("question"),
            timeout_ms,
            reasoning_effort=params.get("reasoning_effort", "low"),
        )
    if method == "chat.side.get":
        _require_only(params, {"session_id", "side_question_id"})
        return runtime.get_side_question(
            params.get("session_id"),
            params.get("side_question_id"),
        )
    if method == "chat.side.list":
        _require_only(params, {"session_id"})
        return runtime.list_side_questions(params.get("session_id"))
    if method == "chat.side.cancel":
        _require_only(params, {"session_id", "side_question_id"})
        return runtime.cancel_side_question(
            params.get("session_id"),
            params.get("side_question_id"),
        )
    if method == "chat.steer":
        _require_only(params, {"operation_id", "instruction"})
        return runtime.steer_operation(
            params.get("operation_id"),
            params.get("instruction"),
        )
    if method == "history.search":
        _require_only(params, {"query", "limit"})
        return runtime.search_history(params.get("query"), params.get("limit", 50))
    if method == "chat.cancel":
        _require_only(params, {"operation_id"})
        return runtime.cancel_operation(params.get("operation_id"))
    if method == "operation.get":
        _require_only(params, {"operation_id"})
        return runtime.get_operation(params.get("operation_id"))
    if method == "question.get":
        _require_only(params, {"session_id", "question_id"})
        return runtime.get_question(params.get("session_id"), params.get("question_id"))
    if method == "question.respond":
        _require_only(params, {"session_id", "question_id", "answers", "annotations"})
        return runtime.respond_question(
            params.get("session_id"),
            params.get("question_id"),
            params.get("answers"),
            params.get("annotations"),
        )
    if method == "question.reject":
        _require_only(params, {"session_id", "question_id"})
        return runtime.reject_question(params.get("session_id"), params.get("question_id"))
    raise BridgeError("METHOD_NOT_FOUND", f"unknown method: {method}")


def _dispatch_goal(
    method: str,
    params: dict[str, Any],
    runtime: SessionRuntime | None,
    goals: GoalRuntime | None,
) -> dict[str, Any]:
    if runtime is None or goals is None:
        raise BridgeError("METHOD_NOT_AVAILABLE", "goal runtime is not available")
    session_id = params.get("session_id")
    runtime.get_session(session_id)
    if method == "goal.create":
        _require_only(params, {"session_id", "objective", "queue"})
        return goals.create(
            session_id,
            params.get("objective"),
            queue=bool(params.get("queue", False)),
        )
    if method == "goal.list":
        _require_only(params, {"session_id", "include_history"})
        return goals.list(
            session_id,
            include_history=bool(params.get("include_history", True)),
        )
    if method == "goal.get":
        _require_only(params, {"session_id", "goal_id"})
        return goals.get(session_id, params.get("goal_id"))
    if method == "goal.run":
        _require_only(
            params,
            {
                "session_id",
                "goal_id",
                "timeout_ms",
                "reasoning_effort",
                "permission_mode",
            },
        )
        goal_id = params.get("goal_id")
        goal = goals.get(session_id, goal_id)
        if goal["status"] not in {"active", "blocked"}:
            raise GoalRuntimeError(
                "GOAL_NOT_RUNNABLE",
                f"goal status {goal['status']} cannot be started",
            )
        operation = runtime.start_chat(
            session_id,
            goal["objective"],
            params.get("timeout_ms", DEFAULT_TIMEOUT_MS),
            reasoning_effort=params.get("reasoning_effort", "medium"),
            permission_mode=params.get("permission_mode"),
            context={"goal": True, "goal_id": goal_id},
        )
        bound = goals.bind_operation(session_id, goal_id, operation["operation_id"])
        # Very fast/fake agents can settle before the operation id is persisted
        # in the goal store.  Reconcile once after binding so the durable
        # lifecycle cannot remain stuck in ``running`` after a terminal turn.
        latest = runtime.get_operation(operation["operation_id"])
        terminal_events = {
            "succeeded": "operation.completed",
            "incomplete": "operation.completed",
            "failed": "operation.failed",
            "cancelled": "operation.cancelled",
            "timed_out": "operation.timed_out",
        }
        if latest.get("status") in terminal_events:
            goals.observe_event(
                {
                    "type": terminal_events[latest["status"]],
                    "operation_id": operation["operation_id"],
                    "data": {
                        "message": latest.get("error", ""),
                    },
                }
            )
            bound = goals.get(session_id, goal_id)
        return {"goal": bound, "operation": operation}
    if method == "goal.pause":
        _require_only(params, {"session_id", "goal_id"})
        goal_id = params.get("goal_id")
        operation_id = goals.operation_for_goal(session_id, goal_id)
        goal = goals.pause(session_id, goal_id)
        if operation_id:
            runtime.cancel_chat(operation_id)
        return goal
    if method == "goal.resume":
        _require_only(params, {"session_id", "goal_id"})
        return goals.resume(session_id, params.get("goal_id"))
    if method == "goal.replace":
        _require_only(params, {"session_id", "goal_id", "objective"})
        return goals.replace(
            session_id,
            params.get("goal_id"),
            params.get("objective"),
        )
    if method == "goal.cancel":
        _require_only(params, {"session_id", "goal_id"})
        goal_id = params.get("goal_id")
        operation_id = goals.operation_for_goal(session_id, goal_id)
        goal = goals.cancel(session_id, goal_id)
        if operation_id:
            runtime.cancel_chat(operation_id)
        return goal
    if method == "goal.delete":
        _require_only(params, {"session_id", "goal_id"})
        return goals.delete_queued(session_id, params.get("goal_id"))
    if method == "goal.reorder":
        _require_only(params, {"session_id", "goal_ids"})
        return goals.reorder(session_id, params.get("goal_ids"))
    raise BridgeError("METHOD_NOT_FOUND", f"unknown method: {method}")


def _dispatch_action(
    method: str,
    params: dict[str, Any],
    runtime: SessionRuntime | None,
    actions: ActionRuntime | None,
    tasks: TaskRuntime | None = None,
) -> dict:
    if runtime is None or actions is None:
        raise BridgeError("METHOD_NOT_AVAILABLE", "action runtime is not available")
    session_id = params.get("session_id")
    session = runtime.get_session(session_id)
    metadata_methods = {"action.list", "file.history", "approval.get", "diff.get", "tool.get"}
    if session["status"] != "active" and method not in metadata_methods:
        raise BridgeError("SESSION_CLOSED", "session is closed")
    if method == "action.list":
        _require_only(params, {"session_id", "limit"})
        return actions.list_actions(session_id, params.get("limit", 50))
    if method == "file.history":
        _require_only(params, {"session_id", "file_path", "limit"})
        if not get_feature_flags().enabled("file_history"):
            raise BridgeError("FEATURE_DISABLED", "file history is disabled by feature policy")
        return actions.list_file_history(session_id, params.get("file_path"), params.get("limit", 50))
    if method == "diff.preview":
        _require_only(params, {"session_id", "file_path", "new_content", "ttl_seconds"})
        return actions.preview_diff(
            session_id,
            params.get("file_path"),
            params.get("new_content"),
            params.get("ttl_seconds", 300),
        )
    if method == "diff.get":
        _require_only(params, {"session_id", "diff_id"})
        return actions.get_diff(session_id, params.get("diff_id"))
    if method == "diff.reject":
        _require_only(params, {"session_id", "diff_id"})
        return actions.reject_diff(session_id, params.get("diff_id"))
    if method == "diff.apply":
        _require_only(params, {"session_id", "diff_id", "approval_id"})
        return actions.apply_diff(session_id, params.get("diff_id"), params.get("approval_id"))
    if method == "diff.rollback":
        _require_only(params, {"session_id", "diff_id", "approval_id"})
        return actions.rollback_diff(session_id, params.get("diff_id"), params.get("approval_id"))
    if method == "approval.get":
        _require_only(params, {"session_id", "approval_id"})
        return actions.get_approval(session_id, params.get("approval_id"))
    if method == "approval.respond":
        _require_only(params, {"session_id", "approval_id", "decision"})
        return actions.respond_approval(
            session_id,
            params.get("approval_id"),
            params.get("decision"),
        )
    if method == "tool.prepare":
        _require_only(params, {"session_id", "tool_name", "arguments", "ttl_seconds"})
        return actions.prepare_tool(
            session_id,
            params.get("tool_name"),
            params.get("arguments"),
            params.get("ttl_seconds", 300),
        )
    if method == "tool.get":
        _require_only(params, {"session_id", "action_id"})
        return actions.get_tool_action(session_id, params.get("action_id"))
    if method == "tool.reject":
        _require_only(params, {"session_id", "action_id"})
        return actions.reject_tool(session_id, params.get("action_id"))
    if method == "tool.execute":
        _require_only(params, {"session_id", "action_id", "approval_id"})
        return actions.execute_tool(
            session_id,
            params.get("action_id"),
            params.get("approval_id"),
        )
    if method == "tool.execute_async":
        _require_only(params, {"session_id", "action_id", "approval_id"})
        if tasks is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "task runtime is not available")
        return tasks.submit_tool(
            session_id,
            params.get("action_id"),
            params.get("approval_id"),
        )
    if method == "file.write.preview":
        _require_only(params, {"session_id", "target_path", "content", "encoding", "overwrite", "ttl_seconds"})
        return actions.preview_file_write(
            params.get("session_id"),
            params.get("target_path"),
            params.get("content"),
            encoding=params.get("encoding", "utf-8"),
            overwrite=bool(params.get("overwrite", False)),
            ttl_seconds=params.get("ttl_seconds", 300),
        )
    if method == "file.write.get":
        _require_only(params, {"session_id", "artifact_id"})
        return actions.get_file_write(params.get("session_id"), params.get("artifact_id"))
    if method == "file.write.reject":
        _require_only(params, {"session_id", "artifact_id"})
        return actions.reject_file_write(params.get("session_id"), params.get("artifact_id"))
    if method == "file.write.apply":
        _require_only(params, {"session_id", "artifact_id", "approval_id"})
        return actions.apply_file_write(
            params.get("session_id"),
            params.get("artifact_id"),
            params.get("approval_id"),
        )
    raise BridgeError("METHOD_NOT_FOUND", f"unknown method: {method}")


def _dispatch_task(
    method: str,
    params: dict[str, Any],
    runtime: SessionRuntime | None,
    tasks: TaskRuntime | None,
) -> dict:
    if runtime is None or tasks is None:
        raise BridgeError("METHOD_NOT_AVAILABLE", "task runtime is not available")
    session_id = params.get("session_id")
    runtime.get_session(session_id)
    if method == "task.get":
        _require_only(params, {"session_id", "task_id"})
        return tasks.get_task(session_id, params.get("task_id"))
    if method == "task.list":
        _require_only(params, {"session_id", "limit"})
        return tasks.list_tasks(session_id, params.get("limit", 50))
    if method == "task.cancel":
        _require_only(params, {"session_id", "task_id"})
        return tasks.cancel_task(session_id, params.get("task_id"))
    if method == "task.retry":
        _require_only(params, {"session_id", "task_id", "ttl_seconds"})
        return tasks.retry_task(session_id, params.get("task_id"), params.get("ttl_seconds", 300))
    raise BridgeError("METHOD_NOT_FOUND", f"unknown method: {method}")


def _list_plugins() -> dict[str, Any]:
    from arforge.mcp_http import PluginRegistry
    from arforge.mcp_runtime import default_plugin_roots
    from arforge.paths import get_arforge_home
    from arforge.plugin_state import load_plugin_overrides

    result = PluginRegistry().discover(default_plugin_roots(), load_plugin_overrides())
    managed_root = (get_arforge_home() / "plugins").resolve()
    for item in result["items"]:
        manifest = Path(item["manifest_path"]).resolve()
        try:
            relative = manifest.relative_to(managed_root)
            item["managed"] = len(relative.parts) == 2 and relative.name == "plugin.json"
        except ValueError:
            item["managed"] = False
    return result


def _dispatch_product(
    method: str,
    params: dict[str, Any],
    logs: LogRuntime | None,
    settings: SettingsRuntime | None,
    keybindings: KeybindingRuntime | None,
    feedback: FeedbackRuntime | None,
    service: ProductService | None = None,
) -> dict:
    graph_params = {
        "workflow.graph.start": {
            "path",
            "session_id",
            "permission_mode",
            "max_parallel",
        },
        "workflow.graph.pause": {"run_id"},
        "workflow.graph.resume": {"run_id"},
        "workflow.graph.cancel": {"run_id"},
        "workflow.graph.approve": {"run_id", "node_id", "approved", "comment"},
        "workflow.graph.retry": {"run_id", "node_id", "include_descendants"},
    }
    if method in graph_params:
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, graph_params[method])
        try:
            return service.methods()[method](params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
        except Exception as exc:
            from arforge.workflow_graph_runtime import WorkflowGraphError

            if isinstance(exc, WorkflowGraphError):
                raise BridgeError(exc.code, exc.message) from None
            raise
    if method == "themes.list":
        _require_only(params, set())
        from arforge.ui_themes import list_ui_themes

        return list_ui_themes()
    if method == "custom_agents.list":
        _require_only(params, set())
        from arforge.custom_agent_profiles import (
            custom_agents_enabled,
            discover_custom_agent_profiles,
            profile_directory,
        )
        from arforge.trust_screen import is_workspace_trusted

        workspace = Path.cwd().resolve()
        profiles, errors = discover_custom_agent_profiles(workspace)
        return {
            "workspace": str(workspace),
            "directory": str(profile_directory(workspace)),
            # Report durable trust for this exact workspace. Process-wide
            # auto-trust is an entry-flow instruction, not persisted evidence
            # that a project-scoped agent profile is authorized here.
            "workspace_trusted": is_workspace_trusted(workspace),
            "enabled": custom_agents_enabled(workspace),
            "activation": "ARFORGE_ENABLE_CUSTOM_AGENTS=1",
            "profiles": [profile.public() for profile in profiles],
            "errors": errors,
        }
    if method == "plugins.list":
        _require_only(params, set())
        return _list_plugins()
    if method == "plugins.set_enabled":
        _require_only(params, {"name", "enabled"})
        name = params.get("name")
        enabled = params.get("enabled")
        if not isinstance(name, str) or not name.strip() or not isinstance(enabled, bool):
            raise BridgeError("INVALID_PARAMS", "name must be a non-empty string and enabled must be boolean")
        from arforge.plugin_state import set_plugin_enabled

        discovered = _list_plugins()
        matches = [item for item in discovered["items"] if item["name"].casefold() == name.strip().casefold()]
        if len(matches) != 1:
            raise BridgeError("PLUGIN_NOT_FOUND", f"plugin not found or ambiguous: {name.strip()}")
        set_plugin_enabled(Path(matches[0]["manifest_path"]), enabled)
        return _list_plugins()
    if method == "plugins.install.inspect":
        _require_only(params, {"source"})
        source = params.get("source")
        if not isinstance(source, str):
            raise BridgeError("INVALID_PARAMS", "source must be a string")
        from arforge.plugin_install import PluginInstallError, PluginInstallRuntime

        try:
            return PluginInstallRuntime().inspect(source)
        except PluginInstallError as exc:
            raise BridgeError(exc.code, exc.message) from None
    if method == "plugins.install.apply":
        _require_only(params, {"token", "name", "replace"})
        token = params.get("token")
        name = params.get("name", "")
        replace = params.get("replace", False)
        if not isinstance(token, str) or not isinstance(name, str) or not isinstance(replace, bool):
            raise BridgeError("INVALID_PARAMS", "token and name must be strings and replace must be boolean")
        from arforge.plugin_install import PluginInstallError, PluginInstallRuntime

        try:
            transaction = PluginInstallRuntime().apply(token, name, replace=replace)
        except PluginInstallError as exc:
            raise BridgeError(exc.code, exc.message) from None
        return {"transaction": transaction, "plugins": _list_plugins()}
    if method == "plugins.remove":
        _require_only(params, {"name"})
        name = params.get("name")
        if not isinstance(name, str):
            raise BridgeError("INVALID_PARAMS", "name must be a string")
        from arforge.plugin_install import PluginInstallError, PluginInstallRuntime

        try:
            transaction = PluginInstallRuntime().remove(name)
        except PluginInstallError as exc:
            raise BridgeError(exc.code, exc.message) from None
        return {"transaction": transaction, "plugins": _list_plugins()}
    if method == "plugins.restore":
        _require_only(params, {"recovery_id"})
        recovery_id = params.get("recovery_id")
        if not isinstance(recovery_id, str):
            raise BridgeError("INVALID_PARAMS", "recovery_id must be a string")
        from arforge.plugin_install import PluginInstallError, PluginInstallRuntime

        try:
            transaction = PluginInstallRuntime().restore(recovery_id)
        except PluginInstallError as exc:
            raise BridgeError(exc.code, exc.message) from None
        return {"transaction": transaction, "plugins": _list_plugins()}
    if method == "output_styles.list":
        _require_only(params, set())
        from arforge.output_styles import list_output_styles

        return list_output_styles()
    if method == "output_styles.read":
        _require_only(params, {"style_id"})
        style_id = params.get("style_id")
        if not isinstance(style_id, str) or not style_id.strip():
            raise BridgeError("INVALID_PARAMS", "style_id must be a non-empty string")
        from arforge.output_styles import find_output_style

        style = find_output_style(style_id)
        if style is None:
            raise BridgeError("OUTPUT_STYLE_NOT_FOUND", f"unknown response style: {style_id}")
        return style.to_dict()
    if method == "output_styles.set":
        _require_only(params, {"style_id"})
        style_id = params.get("style_id")
        if not isinstance(style_id, str) or not style_id.strip():
            raise BridgeError("INVALID_PARAMS", "style_id must be a non-empty string")
        from arforge.output_styles import list_output_styles, set_active_output_style

        try:
            set_active_output_style(style_id)
        except ValueError as exc:
            raise BridgeError("INVALID_OUTPUT_STYLE", str(exc)) from None
        return list_output_styles()
    if method == "output_styles.clear":
        _require_only(params, set())
        from arforge.output_styles import clear_active_output_style, list_output_styles

        clear_active_output_style()
        return list_output_styles()
    if method == "logs.query":
        if logs is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "log runtime is not available")
        _require_only(params, {"limit", "cursor", "levels"})
        return logs.query(
            limit=params.get("limit", 50),
            cursor=params.get("cursor"),
            levels=params.get("levels"),
        )
    if method in {"keybindings.get", "keybindings.update", "keybindings.reset"}:
        if keybindings is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "keybinding runtime is not available")
        if method == "keybindings.get":
            _require_only(params, set())
            return keybindings.get()
        if method == "keybindings.update":
            _require_only(params, {"bindings", "expected_revision"})
            return keybindings.update(params.get("bindings"), params.get("expected_revision"))
        _require_only(params, {"expected_revision"})
        return keybindings.reset(params.get("expected_revision"))
    if method in {"feedback.summary", "feedback.list", "feedback.submit", "feedback.delete"}:
        if feedback is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "feedback runtime is not available")
        if method == "feedback.summary":
            _require_only(params, set())
            return feedback.summary()
        if method == "feedback.list":
            _require_only(params, {"limit", "category"})
            return feedback.list(params.get("limit", 50), params.get("category"))
        if method == "feedback.submit":
            _require_only(params, {"category", "rating", "message", "session_id"})
            return feedback.submit(
                category=params.get("category"),
                rating=params.get("rating"),
                message=params.get("message"),
                session_id=params.get("session_id"),
            )
        _require_only(params, {"feedback_id"})
        return feedback.delete(params.get("feedback_id"))
    if method in {"features.set", "features.clear", "features.refresh"}:
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"flag_id", "enabled"} if method == "features.set" else ({"flag_id"} if method == "features.clear" else set()))
        try:
            if method == "features.set":
                return service.feature_flag_set(params)
            if method == "features.clear":
                return service.feature_flag_clear(params)
            return service.feature_flag_refresh(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "permissions.mode.set":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"mode"})
        try:
            return service.permission_mode_set(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "permissions.rule.add":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"subject", "category", "scope", "decision", "reason", "ttl_seconds"})
        try:
            return service.permission_rule_add(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "permissions.rule.revoke":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"rule_id"})
        try:
            return service.permission_rule_revoke(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "skills.enable":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"skill_id"})
        try:
            return service.skills_enable(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "skills.disable":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"skill_id"})
        try:
            return service.skills_disable(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "skills.refresh":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, set())
        return service.skills_refresh(params)
    if method == "learning.undo":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"learning_id"})
        try:
            return service.learning_undo(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "learning.dogfood_sync":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"limit"})
        try:
            return service.learning_dogfood_sync(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "memory.delete":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"memory_id"})
        try:
            return service.memory_delete(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "memory.bulk_delete":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"memory_ids"})
        try:
            return service.memory_bulk_delete(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "memory.update":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"memory_id", "content", "mem_type", "tags", "importance", "source"})
        try:
            return service.memory_update(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "memory.governance.apply":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"limit"})
        try:
            return service.memory_governance_apply(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "run.revert":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"run_id"})
        try:
            return service.run_revert(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    if method == "run.trace.import":
        if service is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "product service is not available")
        _require_only(params, {"content"})
        try:
            return service.run_trace_import(params)
        except ValueError as exc:
            raise BridgeError("INVALID_PARAMS", str(exc)) from None
    # Model config methods (secure, no settings runtime needed)
    if method == "model_config.list":
        _require_only(params, set())
        from arforge.product.model_config_runtime import get_model_config
        return {"providers": get_model_config().list_providers()}
    if method == "model_config.active":
        _require_only(params, set())
        from arforge.product.model_config_runtime import get_model_config
        mc = get_model_config()
        return {"active_provider": mc.get_active_provider(), "providers": mc.list_providers()}
    if method == "model_config.set_active":
        _require_only(params, {"provider_id"})
        from arforge.product.model_config_runtime import get_model_config
        return get_model_config().set_active_provider(params["provider_id"])
    if method == "model_config.set_key":
        _require_only(params, {"provider_id", "api_key"})
        from arforge.product.model_config_runtime import get_model_config
        return get_model_config().set_api_key(params["provider_id"], params["api_key"])
    if method == "model_config.delete_key":
        _require_only(params, {"provider_id"})
        from arforge.product.model_config_runtime import get_model_config
        return get_model_config().delete_api_key(params["provider_id"])
    if method == "model_config.set_model":
        _require_only(params, {"provider_id", "model"})
        from arforge.product.model_config_runtime import get_model_config
        return get_model_config().set_model(params["provider_id"], params["model"])
    if method == "model_config.set_context_window":
        _require_only(params, {"provider_id", "context_window_tokens"})
        from arforge.product.model_config_runtime import get_model_config
        return get_model_config().set_context_window(params["provider_id"], params["context_window_tokens"])
    if method == "model_config.set_base_url":
        _require_only(params, {"provider_id", "base_url"})
        from arforge.product.model_config_runtime import get_model_config
        return get_model_config().set_base_url(params["provider_id"], params.get("base_url", ""))
    if method == "model_config.set_label":
        _require_only(params, {"provider_id", "label"})
        from arforge.product.model_config_runtime import get_model_config
        return get_model_config().set_display_label(params["provider_id"], params.get("label", ""))
    if settings is None:
        raise BridgeError("METHOD_NOT_AVAILABLE", "settings runtime is not available")
    if method == "settings.get":
        _require_only(params, set())
        return settings.get()
    if method == "settings.update":
        _require_only(params, {"changes", "expected_revision"})
        return settings.update(params.get("changes"), params.get("expected_revision"))
    raise BridgeError("METHOD_NOT_FOUND", f"unknown method: {method}")


def _dispatch_git(method: str, params: dict[str, Any], service: ProductService) -> dict:
    methods = service.methods()
    if method == "git.checkout":
        _require_only(params, {"branch", "create"})
        try:
            return methods[method](params)
        except ValueError as exc:
            raise BridgeError("GIT_OPERATION_FAILED", str(exc)) from None
    if method == "git.worktree.create":
        _require_only(params, {"branch", "name"})
        try:
            return methods[method](params)
        except ValueError as exc:
            raise BridgeError("GIT_OPERATION_FAILED", str(exc)) from None
    if method == "git.worktree.remove":
        _require_only(params, {"root"})
        try:
            return methods[method](params)
        except ValueError as exc:
            raise BridgeError("GIT_OPERATION_FAILED", str(exc)) from None
    if method == "git.worktree.prepare_remove":
        _require_only(params, set())
        try:
            return methods[method](params)
        except ValueError as exc:
            raise BridgeError("GIT_OPERATION_FAILED", str(exc)) from None
    raise BridgeError("METHOD_NOT_FOUND", f"unknown method: {method}")


def dispatch(
    request: Any,
    service: ProductService | None = None,
    runtime: SessionRuntime | None = None,
    goals: GoalRuntime | None = None,
    actions: ActionRuntime | None = None,
    tasks: TaskRuntime | None = None,
    logs: LogRuntime | None = None,
    settings: SettingsRuntime | None = None,
    keybindings: KeybindingRuntime | None = None,
    feedback: FeedbackRuntime | None = None,
    *,
    capability_only: bool = False,
) -> dict:
    """Validate and execute one request, always returning a stable envelope."""
    request_id = request.get("id") if isinstance(request, dict) else None
    version = request.get("version", "1.0") if isinstance(request, dict) else "1.0"
    try:
        if not isinstance(request, dict):
            raise BridgeError("INVALID_REQUEST", "request must be a JSON object")
        if request.get("protocol", PROTOCOL) != PROTOCOL:
            raise BridgeError("UNSUPPORTED_PROTOCOL", f"protocol must be {PROTOCOL}")
        if not isinstance(version, str) or version not in SUPPORTED_VERSIONS:
            raise BridgeError(
                "UNSUPPORTED_VERSION",
                f"supported versions are {', '.join(sorted(SUPPORTED_VERSIONS))}",
            )
        method = request.get("method")
        if not isinstance(method, str) or not method:
            raise BridgeError("INVALID_REQUEST", "method must be a non-empty string")
        if capability_only and method not in CAPABILITY_METHODS:
            raise BridgeError(
                "METHOD_NOT_ALLOWED",
                f"method is outside the integrated capability boundary: {method}",
            )
        params = request.get("params", {})
        if not isinstance(params, dict):
            raise BridgeError("INVALID_PARAMS", "params must be a JSON object")

        backend = service or ProductService()
        methods = backend.methods()
        if method == "protocol.describe":
            _require_only(params, set())
            result = _describe(
                version,
                backend,
                capability_only=capability_only,
            )
        elif method in READ_ONLY_METHODS:
            if method == "runtime.metrics":
                _require_only(params, {"window_hours", "bucket", "limit"})
            elif method == "skills.list":
                _require_only(params, {"cached"})
            elif method == "skills.read":
                _require_only(params, {"skill_id", "max_chars"})
            elif method == "skills.route":
                _require_only(params, {"request"})
            elif method == "customizations.render":
                _require_only(params, {"name", "args"})
            elif method == "subagents.roles":
                _require_only(params, set())
            elif method == "file_state.list":
                _require_only(params, {"limit"})
            elif method == "cost.optimization":
                _require_only(params, {"limit"})
            elif method == "repo.scale":
                _require_only(params, {"path", "query", "max_files", "limit"})
            elif method == "quality.assess":
                _require_only(params, {"files", "patch_text"})
            elif method == "sandbox.status":
                _require_only(params, {"limit"})
            elif method == "multimodal.diagnose":
                _require_only(params, {"filename", "extracted_text", "limit"})
            elif method == "memory.search":
                _require_only(params, {"query", "mem_type", "tag", "source", "project_id", "workspace_path", "importance_min", "limit"})
            elif method == "memory.facets":
                _require_only(params, {"limit"})
            elif method == "memory.governance.preview":
                _require_only(params, {"limit", "sample_limit"})
            elif method == "memory.semantic_search":
                _require_only(params, {"query", "project_id", "workspace_path", "top_k", "limit"})
            elif method == "memory.recall_quality":
                _require_only(params, {"project_id", "workspace_path", "limit", "min_score"})
            elif method == "plan.preview":
                _require_only(params, {"task", "plan_text", "explored_files", "estimated_steps"})
            elif method == "git.diff":
                _require_only(params, {"max_chars"})
            elif method == "run.list":
                _require_only(params, {"limit"})
            elif method == "run.report":
                _require_only(params, {"run_id"})
            elif method == "run.trace.export":
                _require_only(params, {"run_id"})
            elif method == "workflows.preview":
                _require_only(params, {"path"})
            elif method == "workflow.graph.list":
                _require_only(params, {"session_id", "limit"})
            elif method == "workflow.graph.get":
                _require_only(params, {"run_id"})
            elif method == "workflow.graph.events":
                _require_only(params, {"run_id", "after", "limit"})
            else:
                _require_only(params, set())
            try:
                result = methods[method](params)
            except ValueError as exc:
                raise BridgeError("INVALID_PARAMS", str(exc)) from None
            except Exception as exc:
                from arforge.workflow_graph_runtime import WorkflowGraphError

                if isinstance(exc, WorkflowGraphError):
                    raise BridgeError(exc.code, exc.message) from None
                raise
        elif method in SESSION_METHODS and version in ("1.1", "1.2"):
            result = _dispatch_session(method, params, runtime, actions, tasks, settings)
        elif method in GOAL_METHODS and version in ("1.1", "1.2"):
            result = _dispatch_goal(method, params, runtime, goals)
        elif method in ACTION_METHODS and version in ("1.1", "1.2"):
            result = _dispatch_action(method, params, runtime, actions, tasks)
        elif method in TASK_METHODS and version in ("1.1", "1.2"):
            result = _dispatch_task(method, params, runtime, tasks)
        elif method in PRODUCT_METHODS and version in ("1.1", "1.2"):
            result = _dispatch_product(method, params, logs, settings, keybindings, feedback, backend)
        elif method in GIT_METHODS and version in ("1.1", "1.2"):
            result = _dispatch_git(method, params, backend)
        else:
            raise BridgeError("METHOD_NOT_FOUND", f"unknown method: {method}")
        return _envelope(request_id, version=version, data=result)
    except BridgeError as exc:
        return _envelope(
            request_id,
            version=version if isinstance(version, str) and version in SUPPORTED_VERSIONS else PROTOCOL_VERSION,
            error={"code": exc.code, "message": exc.message},
        )
    except SessionRuntimeError as exc:
        return _envelope(
            request_id,
            version=version,
            error={"code": exc.code, "message": exc.message},
        )
    except ActionRuntimeError as exc:
        return _envelope(
            request_id,
            version=version,
            error={"code": exc.code, "message": exc.message},
        )
    except TaskRuntimeError as exc:
        return _envelope(
            request_id,
            version=version,
            error={"code": exc.code, "message": exc.message},
        )
    except GoalRuntimeError as exc:
        return _envelope(
            request_id,
            version=version,
            error={"code": exc.code, "message": exc.message},
        )
    except (FeedbackRuntimeError, KeybindingRuntimeError, LogRuntimeError, ModelConfigError, SettingsRuntimeError) as exc:
        return _envelope(
            request_id,
            version=version,
            error={"code": exc.code, "message": exc.message},
        )
    except ProfileLockError:
        return _envelope(
            request_id,
            version=version,
            error={
                "code": "PROFILE_BUSY",
                "message": "another Arforge process is updating the private profile",
            },
        )
    except Exception as exc:
        message = sanitize_log_message(str(exc)) or "backend operation failed"
        return _envelope(
            request_id,
            version=version if isinstance(version, str) and version in SUPPORTED_VERSIONS else PROTOCOL_VERSION,
            error={"code": "BACKEND_ERROR", "message": message},
        )


def _parse_line(line: str) -> Any:
    # Windows automation shells can prefix the first UTF-8 JSONL record with
    # a BOM. Accept it only at the transport boundary; JSON stays strict.
    line = line.lstrip("\ufeff")
    try:
        request_size = len(line.encode("utf-8"))
    except UnicodeEncodeError:
        raise BridgeError("INVALID_UNICODE", "request is not valid UTF-8") from None
    if request_size > MAX_REQUEST_BYTES:
        raise BridgeError("REQUEST_TOO_LARGE", "request exceeds 1 MiB")
    try:
        return json.loads(line)
    except json.JSONDecodeError as exc:
        raise BridgeError("PARSE_ERROR", f"invalid JSON at column {exc.colno}") from None


def _bridge_mode() -> str:
    mode = os.environ.get("ARFORGE_BRIDGE_MODE", "full").strip().casefold()
    if mode not in {"full", "capability"}:
        raise BridgeError(
            "INVALID_BRIDGE_MODE",
            "ARFORGE_BRIDGE_MODE must be full or capability",
        )
    return mode


def _serve_capability(input_stream: TextIO, output_stream: TextIO) -> int:
    """Serve the bounded integration surface without legacy product stores."""
    _register_builtin_tools()
    service = ProductService()
    for line in input_stream:
        if not line.strip():
            continue
        try:
            request = _parse_line(line)
            response = dispatch(
                request,
                service=service,
                capability_only=True,
            )
        except BridgeError as exc:
            response = _envelope(
                None,
                version="1.1",
                error={"code": exc.code, "message": exc.message},
            )
        output_stream.write(
            json.dumps(
                response,
                ensure_ascii=True,
                separators=(",", ":"),
            )
            + "\n"
        )
        output_stream.flush()
    return 0


def serve(input_stream: TextIO, output_stream: TextIO) -> int:
    """Serve newline-delimited requests until EOF without contaminating stdout."""
    if _bridge_mode() == "capability":
        return _serve_capability(input_stream, output_stream)
    return _serve_full(input_stream, output_stream)


def _serve_full(input_stream: TextIO, output_stream: TextIO) -> int:
    """Serve the legacy-compatible full Bridge surface."""
    output_lock = threading.Lock()
    goals = GoalRuntime(data_path("state", "goals.db"))

    def write(payload: dict[str, Any]) -> None:
        rendered = json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n"
        with output_lock:
            output_stream.write(rendered)
            output_stream.flush()

    def emit_event(event: dict[str, Any]) -> None:
        goals.observe_event(event)
        write({"protocol": PROTOCOL, "version": PROTOCOL_VERSION, "event": True, **event})

    state_store = BridgeStateStore(data_path("state", "bridge_state.db"))
    project = state_store.ensure_project(Path.cwd())
    settings = SettingsRuntime(data_path("settings.json"), data_path(".arforge_lang"))
    keybindings = KeybindingRuntime(data_path("keybindings.json"))
    feedback = FeedbackRuntime(data_path("state", "feedback.db"))
    logs = LogRuntime(data_path("logs", "arforge.log"))
    # Register the built-in tool set so the agentic chat loop (run_agentic) can
    # discover and call tools — parity with ``arforge code``. Registration is
    # import-time side-effect, so the imports must happen before SessionRuntime
    # starts a chat. ARFORGE_WORKSPACE is owned by the desktop host; when it
    # trusted the current directory we bind file/shell tools to the real cwd
    # (same logic as the CLI), otherwise the sandbox default applies.
    if not os.environ.get("ARFORGE_WORKSPACE"):
        try:
            from arforge.trust_screen import _auto_trust_enabled, is_workspace_trusted

            if _auto_trust_enabled() or is_workspace_trusted():
                os.environ["ARFORGE_WORKSPACE"] = "trust-cwd"
        except Exception:  # noqa: BLE001 - trust probe must not block the bridge
            pass
    _register_builtin_tools()
    _install_agentic_hooks()
    from arforge.scheduled_prompt_runtime import get_scheduled_prompt_manager
    from arforge.product.prompt_queue_runtime import PromptQueueRuntime

    scheduler = get_scheduled_prompt_manager()
    prompt_queue = PromptQueueRuntime(data_path("state", "prompt_queue.db"))
    runtime = SessionRuntime(
        emit_event,
        store=state_store,
        project=project,
        scheduler=scheduler,
        prompt_queue=prompt_queue,
    )

    def emit_schedule_event(event: dict[str, Any]) -> None:
        data = event.get("data")
        session_id = data.get("session_id") if isinstance(data, dict) else None
        emit_event(
            {
                "session_id": session_id or "",
                "sequence": 0,
                **event,
            }
        )

    scheduler.start(
        runtime.enqueue_scheduled_prompt,
        on_event=emit_schedule_event,
    )
    action_events: list[dict[str, Any]] = []
    serving_thread = threading.get_ident()

    def emit_action(event: dict[str, Any]) -> None:
        # Stamp the current chat operation_id so the desktop client can hang
        # tool/approval/artifact events off the streaming assistant message.
        session_id = event.get("session_id")
        if isinstance(session_id, str) and "operation_id" not in event:
            operation_id = runtime.active_operation_id(session_id)
            if operation_id:
                event = {**event, "operation_id": operation_id}
        if threading.get_ident() == serving_thread:
            action_events.append(event)
        else:
            emit_event(event)

    actions = ActionRuntime(Path.cwd(), emit_action, store=state_store)
    tasks = TaskRuntime(actions, emit_event, TaskStore(data_path("state", "bridge_tasks.db")))
    try:
        for line in input_stream:
            if not line.strip():
                continue
            request: Any = None
            try:
                request = _parse_line(line)
                response = dispatch(
                    request,
                    runtime=runtime,
                    goals=goals,
                    actions=actions,
                    tasks=tasks,
                    logs=logs,
                    settings=settings,
                    keybindings=keybindings,
                    feedback=feedback,
                )
            except BridgeError as exc:
                response = _envelope(
                    None,
                    version="1.1",
                    error={"code": exc.code, "message": exc.message},
                )
            write(response)
            while action_events:
                emit_event(action_events.pop(0))
            if (
                isinstance(request, dict)
                and request.get("method") in {"chat.start", "chat.resume"}
                and response.get("ok")
            ):
                runtime.release_operation(response["data"]["operation_id"])
            if (
                isinstance(request, dict)
                and request.get("method") == "tool.execute_async"
                and response.get("ok")
            ):
                tasks.release_task(response["data"]["task_id"])
    finally:
        scheduler.stop()
        tasks.shutdown()
        runtime.shutdown()
    return 0


def main() -> int:
    auxiliary_result = _run_frozen_script_mode()
    if auxiliary_result is not None:
        return auxiliary_result
    # Frozen Windows executables can inherit the active ANSI code page for
    # redirected standard streams even when the native host writes UTF-8.
    # Reconfigure explicitly so non-ASCII desktop prompts have one stable wire
    # encoding. Surrogate escape keeps malformed bytes request-scoped: the
    # parser returns INVALID_UNICODE instead of terminating the whole sidecar.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="surrogateescape")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    from arforge.database.sqlite_runtime import ProfileWriterLock

    try:
        if _bridge_mode() == "capability":
            return serve(sys.stdin, sys.stdout)
        with ProfileWriterLock(data_path("state", "sidecar.lock")):
            return serve(sys.stdin, sys.stdout)
    except ProfileLockError as exc:
        print(str(exc), file=sys.stderr)
        return 73


if __name__ == "__main__":
    raise SystemExit(main())
