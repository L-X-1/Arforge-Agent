"""Explicit Python compatibility wrapper for the legacy ``update_plan`` tool.

The product owner is the TypeScript/Core ``todowrite`` session todo tool.  This
module remains importable for legacy Python loops and migration fixtures, but is
excluded from the default Python registry so it cannot compete with the
canonical session todo schema, persistence, or permission contract.

The compatibility implementation keeps the old in-memory ``TaskLedger``
behavior until all Python callers have migrated.  It must not be treated as a
second product planning state machine.
"""

from __future__ import annotations

from arforge.core.task_ledger import get_task_ledger, parse_plan
from arforge.tool_registry import ParamSchema, register_tool

_PLAN_DESC = (
    "维护当前任务的执行计划清单（TodoWrite 式）。对需要多步或多文件的任务，先调用本工具"
    "列出步骤，并在推进过程中再次调用以更新每步状态。传入的是完整计划（覆盖式，不是增量）。"
)

_PARAM_DESC = (
    '计划数组的 JSON 字符串。每项形如 {"content": "步骤描述", "status": "pending"}，'
    "status 取值 pending|in_progress|completed，同一时刻最多一个 in_progress。示例："
    '[{"content":"读取现有代码","status":"completed"},'
    '{"content":"实现新模块","status":"in_progress"},'
    '{"content":"写测试并回归","status":"pending"}]'
)


@register_tool(
    "update_plan",
    _PLAN_DESC,
    params=[ParamSchema("plan_json", "string", _PARAM_DESC)],
    priority=90,
    risk="low",
    category="read",
    source=__name__,
)
def update_plan(plan_json: str) -> str:
    """覆盖式更新会话级执行计划，返回渲染后的清单。

    ``parse_plan`` 解析失败会抛 ValueError，由注册表捕获为失败 ToolResult
    回灌模型，使其按参数说明重试。
    """
    items = parse_plan(plan_json)
    ledger = get_task_ledger()
    ledger.replace(items)
    st = ledger.stats()
    return f"计划已更新（{st['completed']}/{st['total']} 完成）：\n{ledger.render()}"
