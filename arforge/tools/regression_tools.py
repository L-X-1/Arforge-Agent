"""v1-G11：回归保护工具 ``run_impacted_tests``。

跑本次改动文件关联的 pytest 测试，确认改动没破坏既有功能——把 G10 verify_work
（静态语法）补强为真跑测试。基于 change_tracker 自动按 test_<name>.py 约定定位。
"""

from __future__ import annotations

from pathlib import Path

from arforge.tool_registry import register_tool


@register_tool(
    "run_impacted_tests",
    "回归保护：跑本次改动文件关联的 pytest 测试（按 test_<name>.py 约定自动定位），"
    "确认改动没破坏既有功能。改完代码、交付前建议调用；返回 passed/failed 与测试文件清单。",
    params=[],
    priority=89,
    risk="medium",
    category="workspace_cmd",
    source=__name__,
)
def run_impacted_tests() -> str:
    from arforge.core.change_tracker import get_change_tracker
    from arforge.core.regression import locate_impacted_tests, run_pytest
    from arforge.tools.file_tools import get_workspace

    changed = get_change_tracker().changed()
    workspace = get_workspace()
    tests = locate_impacted_tests(changed, workspace)
    if not tests:
        return "回归保护：未找到与本次改动关联的测试文件（按 test_<name>.py 约定）。"
    res = run_pytest(tests, workspace)
    if not res["ran"]:
        return "回归保护：" + res["summary"]
    ok = res["failed"] == 0 and res["returncode"] == 0
    status = "✔ 通过" if ok else "✖ 有失败"
    names = ", ".join(Path(t).name for t in tests)
    return (
        f"回归保护 {status}：{res['passed']} passed, {res['failed']} failed"
        f"（跑了 {len(tests)} 个测试文件：{names}）\n{res['summary']}"
    )
