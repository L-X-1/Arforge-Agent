"""G5：子代理派生工具 ``spawn_subagent``。

让主 agent 把一个独立的只读子任务委派给子代理（隔离上下文 + 只读工具集），
子代理只回结论摘要。实现见 ``core.subagent``。category=read → 三模式权限放行。
"""

from __future__ import annotations

from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "spawn_subagent",
    "派生一个子代理完成独立的只读子任务（如探索某模块、调研某主题）。子代理在隔离上下文里"
    "自主调用只读工具，最后只把结论摘要返回给你——适合深入探索又不想让细节占满主上下文。",
    params=[
        ParamSchema("task", "string", "交给子代理的明确子任务描述"),
        ParamSchema("role", "string", "只读子代理角色: explore/explorer(探索)/reviewer(代码审查)/researcher(深度研究)/searcher(检索)/planner(规划)", required=False, default="explore"),
    ],
    priority=92,
    risk="low",
    category="read",
    source=__name__,
)
def spawn_subagent(task: str, role: str = "explore") -> str:
    from arforge.core.subagent import (
        normalize_subagent_role,
        read_only_subagent_roles,
        run_subagent,
    )

    try:
        normalized = normalize_subagent_role(role)
    except ValueError:
        normalized = role
    if normalized not in read_only_subagent_roles():
        allowed = ", ".join(read_only_subagent_roles())
        return (
            f"role '{role}' is not read-only; use spawn_write_subagent for "
            f"write-capable roles. Read-only roles: {allowed}"
        )
    return run_subagent(task, role=normalized)


@register_tool(
    "spawn_write_subagent",
    "派生一个具备受控写入或诊断命令能力的子代理，例如 test-writer 或 debugger。该工具用于明确需要写测试、运行诊断命令的委派任务。",
    params=[
        ParamSchema("task", "string", "交给子代理的明确子任务描述"),
        ParamSchema("role", "string", "写入/诊断型子代理角色：test-writer/tester(测试)、debugger(诊断)、coder(编码)、general(通用)、doc(文档)、data(数据)、verifier/statusline(验证)", required=False, default="test-writer"),
    ],
    priority=93,
    risk="medium",
    category="workspace_write",
    source=__name__,
)
def spawn_write_subagent(task: str, role: str = "test-writer") -> str:
    from arforge.core.subagent import (
        normalize_subagent_role,
        run_subagent,
        write_capable_subagent_roles,
    )

    try:
        normalized = normalize_subagent_role(role)
    except ValueError:
        normalized = role
    if normalized not in write_capable_subagent_roles():
        allowed = ", ".join(write_capable_subagent_roles())
        return (
            f"role '{role}' is read-only or unknown; use spawn_subagent for "
            f"read-only roles. Write-capable roles: {allowed}"
        )
    return run_subagent(task, role=normalized)
