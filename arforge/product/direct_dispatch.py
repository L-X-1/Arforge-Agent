"""Direct dispatch over the canonical agent runtimes.

The JSONL bridge protocol is retired; this module keeps the thin
method-to-runtime mapping used by the web control center and by tests
that exercise the runtimes through the same contract. It never starts a
loop, owns threads, or serialises transport.

"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from arforge.feature_flags import get_feature_flags
from arforge.product.action_runtime import ActionRuntime, ActionRuntimeError
from arforge.product.feedback_runtime import FeedbackRuntime, FeedbackRuntimeError
from arforge.product.goal_runtime import GoalRuntime, GoalRuntimeError
from arforge.product.keybinding_runtime import KeybindingRuntime, KeybindingRuntimeError
from arforge.product.log_runtime import LogRuntime, LogRuntimeError
from arforge.product.model_config_runtime import ModelConfigError
from arforge.product.service import ProductService
from arforge.product.session_runtime import (
    DEFAULT_TIMEOUT_MS,
    SessionRuntime,
    SessionRuntimeError,
)
from arforge.product.settings_runtime import SettingsRuntime, SettingsRuntimeError
from arforge.product.task_runtime import TaskRuntime, TaskRuntimeError

PROTOCOL = "arforge.direct"
PROTOCOL_VERSION = "1.2"
SUPPORTED_VERSIONS = {"1.0", "1.1", "1.2"}


def register_builtin_tools() -> None:
    """Import the built-in tool modules so their ``@register_tool`` side-effects
    populate the global registry, mirroring ``arforge code``.
    """
    from arforge.tools import load_builtin_tools

    load_builtin_tools()


def install_agentic_hooks() -> None:
    """Install the same run-loop infrastructure that ``arforge code`` uses.

    Every installer must be idempotent because these processes are long-lived.
    Optional failures are swallowed per hook.
    """
    installers = (
        ("arforge.core.compaction", "install_compaction_hook"),
        ("arforge.core.interrupt", "install_interrupt_hook"),
        ("arforge.core.change_tracker", "install_change_tracker_hook"),
        ("arforge.core.run_report", "install_run_report_hook"),
        ("arforge.core.run_transaction", "install_run_transaction_hook"),
        ("arforge.core.edit_verify", "install_edit_verify_hook"),
        ("arforge.core.self_correct", "install_self_correct_hook"),
        ("arforge.core.memory_hook", "install_memory_hooks"),
        ("arforge.customization", "install_custom_hooks"),
    )
    import importlib

    for module_name, func_name in installers:
        try:
            module = importlib.import_module(module_name)
            getattr(module, func_name)()
        except Exception:  # noqa: BLE001 - hook install is best-effort
            pass

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
PRODUCT_METHODS = {"logs.query", "settings.get", "settings.update", "keybindings.get", "keybindings.update", "keybindings.reset", "feedback.summary", "feedback.list", "feedback.submit", "feedback.delete", "features.set", "features.clear", "features.refresh", "permissions.mode.set", "permissions.rule.add", "permissions.rule.revoke", "learning.undo", "learning.dogfood_sync", "run.revert", "run.trace.import", "model_config.list", "model_config.active", "model_config.set_key", "model_config.delete_key", "model_config.set_active", "model_config.set_model", "model_config.set_context_window", "model_config.set_base_url", "model_config.set_label", "output_styles.list", "output_styles.read", "output_styles.set", "output_styles.clear", "themes.list", "custom_agents.list"}
GIT_METHODS = {"git.checkout", "git.worktree.create", "git.worktree.prepare_remove", "git.worktree.remove"}
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


def _dispatch_product(
    method: str,
    params: dict[str, Any],
    logs: LogRuntime | None,
    settings: SettingsRuntime | None,
    keybindings: KeybindingRuntime | None,
    feedback: FeedbackRuntime | None,
    service: ProductService | None = None,
) -> dict:
    if method == "themes.list":
        _require_only(params, set())
        from arforge.ui_themes import list_ui_themes

        return list_ui_themes()
    if method == "custom_agents.list":
        _require_only(params, set())
        from arforge.cli_compat import invoke
        from arforge.custom_agent_profiles import typescript_custom_agents_status

        workspace = Path.cwd().resolve()
        status = typescript_custom_agents_status(workspace)
        if status is None:
            raise BridgeError("METHOD_NOT_AVAILABLE", "TypeScript custom-agent owner is unavailable")
        result = invoke(
            ["custom-agents", "list", "--workspace", str(workspace), "--json"],
            cwd=str(workspace),
            env={
                "ARFORGE_DB": ":memory:",
                "ARFORGE_DB_URL": "",
                "DATABASE_URL": "",
                "NO_COLOR": "1",
            },
            timeout=15,
        )
        if result.returncode != 0:
            raise BridgeError("METHOD_NOT_AVAILABLE", "TypeScript custom-agent owner is unavailable")
        try:
            payload = json.loads(result.stdout)
        except (TypeError, ValueError, json.JSONDecodeError):
            raise BridgeError("METHOD_NOT_AVAILABLE", "TypeScript custom-agent owner returned invalid JSON") from None
        if not isinstance(payload, dict) or not isinstance(payload.get("profiles"), list) or not isinstance(payload.get("errors"), list):
            raise BridgeError("METHOD_NOT_AVAILABLE", "TypeScript custom-agent owner returned an invalid report")
        return {
            "workspace": str(workspace),
            "directory": status.get("directory", str(workspace / ".arforge" / "agents")),
            "workspace_trusted": status.get("workspace_trusted") is True,
            "enabled": status.get("enabled") is True,
            "activation": "ARFORGE_ENABLE_CUSTOM_AGENTS=1",
            "profiles": payload["profiles"],
            "errors": payload["errors"],
        }
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


def _describe(version: str) -> dict[str, Any]:
    methods = [
        "protocol.describe",
        *sorted(
            SESSION_METHODS | GOAL_METHODS | ACTION_METHODS | TASK_METHODS | PRODUCT_METHODS | GIT_METHODS
        ),
    ]
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
        "output_styles.clear",
        "output_styles.set",
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
    }
    stateful_methods = SESSION_METHODS | GOAL_METHODS | ACTION_METHODS | TASK_METHODS
    workspace_mutating_methods = {
        "diff.apply",
        "diff.rollback",
        "git.checkout",
        "git.worktree.create",
        "git.worktree.remove",
        "run.revert",
        "tool.execute",
        "tool.execute_async",
    }
    return {
        "protocol": PROTOCOL,
        "version": version,
        "supported_versions": sorted(SUPPORTED_VERSIONS),
        "methods": sorted(methods),
        "transport": "direct",
        "transport_backpressure": "none",
        "mutating_methods": sorted(mutating_methods & set(methods)),
        "stateful_methods": sorted(stateful_methods),
        "workspace_mutating_methods": sorted(workspace_mutating_methods),
    }


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
        params = request.get("params", {})
        if not isinstance(params, dict):
            raise BridgeError("INVALID_PARAMS", "params must be a JSON object")

        backend = service or ProductService()
        if method == "protocol.describe":
            _require_only(params, set())
            result = _describe(version)
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
