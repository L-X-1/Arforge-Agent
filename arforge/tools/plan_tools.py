"""G4：自驱任务清单工具 ``update_plan``（TodoWrite 式）。

注册一个 read 类工具，让 agentic 循环中的模型维护结构化执行计划。
与 ``task_tools.py``（用户级、写 tasks.json 的持久化待办）互不相干：本工具只
操作内存中的会话级 ledger（``core.task_ledger``），不落盘，供 agent 自我编排
长任务用。category=read → 无文件副作用，三模式权限下均放行（plan 模式也可规划）。
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
