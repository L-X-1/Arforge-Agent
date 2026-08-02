"""权限模式切换工具（PM-4）—— 供 LLM 在任务中自主切换 / 用户手动切换。

防自我提权：升到更宽松的模式（如 →fullAccess）必须用户确认；降级始终允许。
这些工具 category=read（控制类、无文件副作用），故各模式下都可被调用；提权安全在工具内部把关。
"""

from __future__ import annotations

from arforge.core.permission import MODE_RANK, PermissionMode, get_permission_manager
from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "set_permission_mode",
    "Switch the agent permission mode. De-escalation (to a stricter mode) is free; "
    "escalation to a more permissive mode (e.g. fullAccess) requires explicit user approval.",
    keywords=["set permission mode", "switch mode", "权限模式"],
    params=[ParamSchema("mode", "string", "requestApproval | autoApprove | fullAccess")],
    category="read",
    source=__name__,
)
def set_permission_mode(mode: str) -> str:
    try:
        target = PermissionMode(mode)
    except ValueError:
        return f"invalid mode: {mode} (use requestApproval | autoApprove | fullAccess)"
    pm = get_permission_manager()
    current = pm.get_mode()
    # 防自我提权：仅当从一个"已激活的、更严格的"模式升到更宽松模式时，要求用户确认。
    if current is not None and MODE_RANK[target] > MODE_RANK[current]:
        from arforge.permission import request_confirmation

        if not request_confirmation("high", f"escalate permission mode {current.value} -> {target.value}"):
            return f"denied: escalation to {target.value} requires user approval (still in {current.value})"
    pm.set_mode(target)
    return f"permission mode set to {target.value}"


@register_tool(
    "enter_plan_mode",
    "Enter read-only PLAN mode (no writes/commands). Always allowed (de-escalation).",
    keywords=["enter plan mode", "plan mode", "计划模式"],
    params=[],
    category="read",
    source=__name__,
)
def enter_plan_mode() -> str:
    get_permission_manager().set_mode(PermissionMode.REQUEST_APPROVAL)
    return "entered requestApproval mode"


@register_tool(
    "exit_plan_mode",
    "Present a plan and request user approval to leave PLAN mode and begin editing "
    "(switches to autoApprove on approval). Use after finishing approval-gated investigation.",
    keywords=["exit plan mode", "approve plan", "退出计划模式"],
    params=[ParamSchema("plan", "string", "the concrete plan you intend to execute")],
    category="read",
    source=__name__,
)
def exit_plan_mode(plan: str) -> str:
    from arforge.permission import request_confirmation

    approved = request_confirmation("high", f"Approve this plan and switch to autoApprove mode?\n\n{plan[:800]}")
    if not approved:
        return "plan not approved; staying in requestApproval mode"
    get_permission_manager().set_mode(PermissionMode.AUTO_APPROVE)
    return "plan approved; switched to autoApprove mode"
