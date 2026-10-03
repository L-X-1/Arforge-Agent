"""Multi-agent security boundaries — capability/tool whitelists, token budgets,
path sandboxing, and audit logging.

Each SubAgent is constrained by its AgentRole definition.  This module provides
enforcement utilities that the dispatcher and pool use to prevent privilege
escalation and resource exhaustion.
"""

from __future__ import annotations

import contextvars
import logging
import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from arforge.multiagent.protocol import AgentRole

logger = logging.getLogger(__name__)

# Default workspace root for file-writing SubAgents
_DEFAULT_WORKSPACE = os.environ.get("ARFORGE_WORKSPACE", str(Path.cwd()))


def _audit_log_path() -> Path:
    base = os.environ.get("ARFORGE_HOME", str(Path.home() / ".arforge"))
    return Path(base) / "multiagent_audit.log"


def audit_log(role: str, action: str, detail: str = "", allowed: bool = True) -> None:
    """Append an audit entry to the multi-agent security log."""
    path = _audit_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = (
        f"[{datetime.now(timezone.utc).isoformat()}] "
        f"role={role} action={action} allowed={allowed}"
    )
    if detail:
        entry += f" detail={detail[:200]}"
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(entry + "\n")
    except Exception:
        pass  # Audit failure must not break dispatch


# ------------------------------------------------------------------
# Capability whitelist
# ------------------------------------------------------------------


def check_capability(role: AgentRole, capability_name: str) -> bool:
    """Return True if *role* permits *capability_name*."""
    allowed = capability_name in role.capabilities
    if not allowed:
        audit_log(
            role.name,
            "capability_blocked",
            f"capability={capability_name}",
            allowed=False,
        )
    return allowed


# ------------------------------------------------------------------
# Tool whitelist
# ------------------------------------------------------------------


def check_tool(role: AgentRole, tool_name: str) -> bool:
    """Return True if *role* permits *tool_name*."""
    allowed = tool_name in role.tools
    if not allowed:
        audit_log(
            role.name,
            "tool_blocked",
            f"tool={tool_name}",
            allowed=False,
        )
    return allowed


# ------------------------------------------------------------------
# Token budget
# ------------------------------------------------------------------


def check_token_budget(role: AgentRole, tokens_used: int) -> bool:
    """Return True if *tokens_used* does not exceed the role's max_tokens."""
    if tokens_used > role.max_tokens:
        audit_log(
            role.name,
            "token_budget_exceeded",
            f"used={tokens_used} max={role.max_tokens}",
            allowed=False,
        )
        return False
    return True


# ------------------------------------------------------------------
# Path sandbox
# ------------------------------------------------------------------


def check_path_write(role: AgentRole, target_path: str | Path) -> bool:
    """Return True if the role is allowed to write to *target_path*.

    Writes are currently restricted to:
    - The workspace root (ARFORGE_WORKSPACE or CWD)
    - The conversation tmp directory (~/.arforge/conversations/)
    """
    scope = current_task_scope()
    workspace = (
        scope.workspace
        if scope is not None and scope.workspace is not None
        else Path(_DEFAULT_WORKSPACE).expanduser().resolve()
    )
    requested = Path(target_path).expanduser()
    if not requested.is_absolute() and PureWindowsPath(str(target_path)).is_absolute():
        audit_log(
            role.name,
            "path_sandbox_blocked",
            f"path={target_path}",
            allowed=False,
        )
        return False
    # Tool paths are workspace-relative by contract.  Resolving a relative
    # path from the host process cwd would silently widen or misapply the
    # boundary when an execution session is bound to a worktree.
    target = (requested if requested.is_absolute() else workspace / requested).resolve()
    conv_dir = (Path(os.environ.get("ARFORGE_HOME", str(Path.home() / ".arforge"))) / "conversations").resolve()

    # Allow primary and explicitly trusted additional workspace roots.
    try:
        from arforge.ts_workspace import typescript_path_is_authorized

        if typescript_path_is_authorized(target, primary=workspace):
            return True
    except Exception:  # noqa: BLE001 - retain the conservative primary-root fallback
        try:
            target.relative_to(workspace)
            return True
        except ValueError:
            pass

    try:
        target.relative_to(conv_dir)
        return True
    except ValueError:
        pass

    # Generic callers retain the historical temporary-file allowance.  A
    # running subagent, however, has an explicit workspace assignment, so a
    # system-wide temp directory must not become an unbounded second workspace.
    if scope is None:
        try:
            import tempfile

            target.relative_to(Path(tempfile.gettempdir()).resolve())
            return True
        except (ValueError, ImportError):
            pass

    audit_log(
        role.name,
        "path_sandbox_blocked",
        f"path={target}",
        allowed=False,
    )
    return False


# ------------------------------------------------------------------
# Convenience: full gate check
# ------------------------------------------------------------------


def gate_check(
    role: AgentRole,
    capability: str = "",
    tool: str = "",
    tokens_used: int = 0,
    write_path: str = "",
) -> dict:
    """Run all security checks and return a verdict dict.

    Returns:
        {"allowed": bool, "checks": [list of passed checks], "blocks": [list of blocked checks]}
    """
    checks: list[str] = []
    blocks: list[str] = []

    if capability and not check_capability(role, capability):
        blocks.append(f"capability '{capability}' not in whitelist")
    else:
        checks.append("capability")

    if tool and not check_tool(role, tool):
        blocks.append(f"tool '{tool}' not in whitelist")
    else:
        checks.append("tool")

    if tokens_used > 0 and not check_token_budget(role, tokens_used):
        blocks.append(f"token budget exceeded ({tokens_used}/{role.max_tokens})")
    else:
        checks.append("token_budget")

    if write_path and not check_path_write(role, write_path):
        blocks.append(f"path '{write_path}' not in sandbox")
    else:
        checks.append("path_sandbox")

    return {"allowed": len(blocks) == 0, "checks": checks, "blocks": blocks}


# ------------------------------------------------------------------
# HK-4：安全沙箱作为 PRE_TOOL_USE 中间件 handler（硬编码 executor → 注册式 handler）
# ------------------------------------------------------------------

# 当前活动角色（子 Agent 执行期间设定），供 sandbox_hook 读取做角色相关的沙箱裁决。
_active_role: contextvars.ContextVar = contextvars.ContextVar("arforge_active_role", default=None)


@dataclass(frozen=True)
class _TaskExecutionScope:
    """Execution facts needed by hook-time multi-agent policy checks.

    The scope is intentionally held in ``ContextVar`` storage rather than on a
    shared agent instance.  A pooled agent can have more than one historical
    task, while a hook must always make its decision for the task currently
    executing on this thread.
    """

    conversation: Any
    task_id: str
    workspace: Path | None
    constraints: frozenset[str]


_active_task_scope: contextvars.ContextVar[_TaskExecutionScope | None] = (
    contextvars.ContextVar("arforge_active_task_scope", default=None)
)


def _normalise_constraint(value: object) -> str:
    """Return a stable comparison form for supported task constraints."""

    return " ".join(str(value).strip().lower().replace("_", "-").split())


@contextmanager
def task_scope(
    conversation: Any,
    task_id: str,
    *,
    workspace: str | Path | None = None,
    constraints: list[str] | tuple[str, ...] | None = None,
):
    """Bind cancellation, workspace, and explicit task constraints to hooks.

    ``run_tool_loop`` calls hooks immediately before every tool invocation.
    Binding the task here lets a daemon worker that outlives its dispatcher
    timeout fail closed instead of continuing to mutate the workspace.
    """

    resolved_workspace = (
        Path(workspace).expanduser().resolve() if workspace is not None else None
    )
    scope = _TaskExecutionScope(
        conversation=conversation,
        task_id=str(task_id),
        workspace=resolved_workspace,
        constraints=frozenset(
            _normalise_constraint(item) for item in (constraints or ()) if str(item).strip()
        ),
    )
    token = _active_task_scope.set(scope)
    try:
        yield
    finally:
        _active_task_scope.reset(token)


def current_task_scope() -> _TaskExecutionScope | None:
    """Return the current hook execution scope, if a subagent owns it."""

    return _active_task_scope.get()


@contextmanager
def role_scope(role):
    """在子 Agent 执行期间设定活动角色；退出自动还原（线程/协程安全）。"""
    token = _active_role.set(role)
    try:
        yield
    finally:
        _active_role.reset(token)


def current_active_role():
    """Return the active subagent role in the current execution context."""

    return _active_role.get()


_INTER_AGENT_TOOLS = frozenset(
    {
        "team_message_send",
        "team_message_list",
        "team_shutdown_respond",
    }
)
_WRITE_TOOL_NAMES = frozenset(
    {
        "apply_patch_batch",
        "create_file",
        "delete_file",
        "edit_file",
        "notebook_edit",
        "python_symbol_rename",
        "replace_in_file",
        "write_docx",
        "write_file",
    }
)
_COMMAND_TOOL_NAMES = frozenset(
    {"cancel_background_cmd", "run_background_cmd", "run_cmd", "run_tests"}
)
_READ_ONLY_CONSTRAINTS = frozenset({"read-only", "read only", "readonly"})
_NO_WRITE_CONSTRAINTS = frozenset(
    {"no file writes", "no-file-writes", "no file write", "no-file-write", "no writes", "no-writes"}
)
_NO_COMMAND_CONSTRAINTS = frozenset(
    {
        "no command execution",
        "no-command-execution",
        "no commands",
        "no-commands",
    }
)


def _tool_category(tool_name: str) -> str:
    """Resolve a tool's declared category without making policy depend on it."""

    try:
        from arforge.tool_registry import REGISTRY

        tool = REGISTRY.get(tool_name)
        if tool is not None:
            category = str(getattr(tool.schema, "category", "") or "")
            if category:
                return category
    except Exception:  # noqa: BLE001 - retain the conservative built-in map
        pass
    if tool_name in _WRITE_TOOL_NAMES:
        return "workspace_write"
    if tool_name in _COMMAND_TOOL_NAMES:
        return "workspace_cmd"
    return ""


def _task_is_cancelled(scope: _TaskExecutionScope) -> bool:
    """Return whether the scoped task has crossed a cancellation boundary."""

    try:
        checker = getattr(scope.conversation, "task_cancelled", None)
        if callable(checker):
            return bool(checker(scope.task_id))
        return bool(getattr(scope.conversation, "cancelled", False))
    except Exception:  # noqa: BLE001 - a missing/failed cancellation source fails closed
        return True


def _constraint_block_reason(scope: _TaskExecutionScope, tool_name: str) -> str:
    """Return a hard-block reason for the task's supported explicit constraints."""

    constraints = scope.constraints
    category = _tool_category(tool_name)
    is_write = category == "workspace_write"
    is_command = category == "workspace_cmd"
    if constraints & _READ_ONLY_CONSTRAINTS and (is_write or is_command):
        return "task constraint 'read-only' forbids workspace writes and commands"
    if constraints & _NO_WRITE_CONSTRAINTS and is_write:
        return "task constraint 'no file writes' forbids workspace writes"
    if constraints & _NO_COMMAND_CONSTRAINTS and is_command:
        return "task constraint 'no command execution' forbids workspace commands"
    return ""


def _role_allows_tool(role: AgentRole, tool_name: str) -> bool:
    """Enforce non-empty role tool whitelists at the execution boundary."""

    allowed = set(getattr(role, "tools", ()) or ())
    # An empty list retains the established generic-agent meaning: no role
    # restriction was declared.  Registered roles have explicit whitelists.
    if not allowed:
        return True
    return tool_name in allowed or tool_name in _INTER_AGENT_TOOLS


def sandbox_hook(ctx):
    """PRE_TOOL_USE handler：按当前活动角色强制路径沙箱 + 命令能力白名单。

    非多 Agent 上下文（无活动角色）时返回 None（放行）——单 Agent 由 permission_decider 把关。
    与 permission_decider(20) 组成同一条 PRE_TOOL_USE 安全漏斗：sandbox 置于 priority=30。
    """
    from arforge.core.hooks import HookDecision

    role = _active_role.get()
    if role is None:
        return None
    name = ctx.tool_name
    args = ctx.tool_args or {}
    scope = current_task_scope()
    if scope is not None:
        if _task_is_cancelled(scope):
            audit_log(
                role.name,
                "tool_blocked_after_cancellation",
                f"task_id={scope.task_id} tool={name}",
                allowed=False,
            )
            return HookDecision.block("task cancelled or deadline exceeded")
        constraint_reason = _constraint_block_reason(scope, name)
        if constraint_reason:
            audit_log(
                role.name,
                "task_constraint_blocked",
                f"task_id={scope.task_id} tool={name} reason={constraint_reason}",
                allowed=False,
            )
            return HookDecision.block(constraint_reason)
    if not _role_allows_tool(role, name):
        audit_log(
            role.name,
            "tool_blocked",
            f"tool={name}",
            allowed=False,
        )
        return HookDecision.block(f"tool '{name}' not permitted for role '{role.name}'")
    if _tool_category(name) == "workspace_write":
        path = args.get("filename") or args.get("path") or ""
        if path and not check_path_write(role, path):
            return HookDecision.block(f"path sandbox blocked: {path}")
    if _tool_category(name) == "workspace_cmd" and not check_capability(role, "command_execution"):
        return HookDecision.block("capability 'command_execution' not permitted")
    return None


def audit_hook(ctx):
    """POST_TOOL_USE observer：把每次工具执行写入审计日志（完整工具执行轨迹，HK-4 续）。

    迁移前审计零散在各 check_* 内（仅记拦截）；此 handler 让"每次工具执行/失败"都进审计，
    与 permission(20)/sandbox(30) 同走 hook 总线，中间件链覆盖到 POST 侧。
    """
    role = _active_role.get()
    role_name = role.name if role is not None else "agent"
    result = ctx.tool_result
    success = getattr(result, "success", True)
    step = (ctx.metadata or {}).get("step", "?")
    audit_log(role_name, f"tool:{ctx.tool_name}", f"step={step}", allowed=bool(success))
    return None


def install_audit_hook():
    """把 audit_hook 幂等注册到 POST_TOOL_USE（observer，priority=90）。"""
    from arforge.core.hooks import HookEvent, get_hook_manager

    mgr = get_hook_manager()
    mgr.unregister(HookEvent.POST_TOOL_USE, audit_hook)
    mgr.register(HookEvent.POST_TOOL_USE, audit_hook, priority=90, name="security_audit")
    return mgr


def install_security_hooks():
    """幂等注册安全中间件：sandbox_hook→PRE_TOOL_USE(30) + audit_hook→POST_TOOL_USE(90)。"""
    from arforge.core.hooks import HookEvent, get_hook_manager

    mgr = get_hook_manager()
    mgr.unregister(HookEvent.PRE_TOOL_USE, sandbox_hook)
    mgr.register(HookEvent.PRE_TOOL_USE, sandbox_hook, priority=30, name="security_sandbox")
    install_audit_hook()
    return mgr
