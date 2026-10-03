"""G4 自驱任务清单（task_ledger + update_plan 工具）测试。"""

from __future__ import annotations

import pytest

from arforge.core.task_ledger import (
    COMPLETED,
    IN_PROGRESS,
    PENDING,
    TaskItem,
    TaskLedger,
    get_task_ledger,
    parse_plan,
    reset_task_ledger,
)


@pytest.fixture(autouse=True)
def _isolate_ledger():
    reset_task_ledger()
    yield
    reset_task_ledger()


# -- TaskLedger 基本行为 ------------------------------------------------------


def test_replace_overwrites():
    led = TaskLedger()
    led.replace([TaskItem("a", PENDING), TaskItem("b", IN_PROGRESS)])
    assert [i.content for i in led.items()] == ["a", "b"]
    led.replace([TaskItem("c", COMPLETED)])  # 覆盖式，非增量
    assert [i.content for i in led.items()] == ["c"]


def test_replace_cleans_empty_and_bad_status():
    led = TaskLedger()
    led.replace([TaskItem("  ok  ", "weird"), TaskItem("   ", PENDING)])
    items = led.items()
    assert len(items) == 1
    assert items[0].content == "ok"  # strip
    assert items[0].status == PENDING  # 非法状态归一为 pending


def test_stats_and_render():
    led = TaskLedger()
    led.replace(
        [
            TaskItem("step1", COMPLETED),
            TaskItem("step2", IN_PROGRESS),
            TaskItem("step3", PENDING),
        ]
    )
    assert led.stats() == {"total": 3, "completed": 1, "in_progress": 1, "pending": 1}
    text = led.render()
    assert "1/3" in text
    assert "✔ step1" in text
    assert "▶ step2" in text
    assert "○ step3" in text


def test_empty_render():
    led = TaskLedger()
    assert led.is_empty()
    assert "空" in led.render()


# -- 单例 + 隔离 --------------------------------------------------------------


def test_singleton_identity():
    assert get_task_ledger() is get_task_ledger()


def test_reset_clears():
    get_task_ledger().replace([TaskItem("x")])
    assert not get_task_ledger().is_empty()
    reset_task_ledger()
    assert get_task_ledger().is_empty()


# -- parse_plan 容错 ----------------------------------------------------------


def test_parse_plan_basic():
    items = parse_plan('[{"content":"a","status":"completed"},{"content":"b","status":"pending"}]')
    assert [(i.content, i.status) for i in items] == [("a", COMPLETED), ("b", PENDING)]


def test_parse_plan_status_aliases():
    items = parse_plan(
        '[{"content":"a","status":"doing"},{"content":"b","status":"done"},{"content":"c","status":"todo"}]'
    )
    assert [i.status for i in items] == [IN_PROGRESS, COMPLETED, PENDING]


def test_parse_plan_alt_keys():
    items = parse_plan('[{"task":"a","state":"in-progress"}]')
    assert items[0].content == "a"
    assert items[0].status == IN_PROGRESS


def test_parse_plan_wrapped_object():
    items = parse_plan('{"plan":[{"content":"a"}]}')
    assert items[0].content == "a"
    assert items[0].status == PENDING  # 缺 status → pending


def test_parse_plan_plain_strings():
    items = parse_plan('["a","b"]')
    assert [i.content for i in items] == ["a", "b"]
    assert all(i.status == PENDING for i in items)


def test_parse_plan_single_object():
    items = parse_plan('{"content":"only"}')
    assert len(items) == 1
    assert items[0].content == "only"


@pytest.mark.parametrize(
    "bad",
    ["", "   ", "not json", "[]", '[{"status":"pending"}]', "123", "null"],
)
def test_parse_plan_invalid_raises(bad):
    with pytest.raises(ValueError):
        parse_plan(bad)


# -- update_plan 工具（经注册表调用）-----------------------------------------


def test_update_plan_tool_updates_ledger():
    import arforge.tools.plan_tools  # noqa: F401  触发注册
    from arforge.tool_registry import REGISTRY

    res = REGISTRY.execute_by_name(
        "update_plan",
        {"plan_json": '[{"content":"读代码","status":"completed"},{"content":"写实现","status":"in_progress"}]'},
    )
    assert res.success, res.error
    assert "1/2" in res.output
    st = get_task_ledger().stats()
    assert st["completed"] == 1
    assert st["in_progress"] == 1


def test_update_plan_tool_bad_input_fails_gracefully():
    import arforge.tools.plan_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    res = REGISTRY.execute_by_name("update_plan", {"plan_json": "not json"})
    assert not res.success  # 失败转成结果回灌模型，而非抛异常
    assert res.error


def test_update_plan_tool_registered_as_read_category():
    import arforge.tools.plan_tools  # noqa: F401
    from arforge.tool_registry import REGISTRY

    tool = REGISTRY.get("update_plan")
    assert tool is not None
    assert tool.schema.category == "read"  # 三模式权限下均放行
    assert tool.schema.risk_level == "low"


def test_python_builtin_registry_excludes_legacy_update_plan_wrapper():
    """TS/Core ``todowrite`` is the default owner; Python stays opt-in."""

    from arforge.tools import BUILTIN_TOOL_MODULES

    assert "arforge.tools.plan_tools" not in BUILTIN_TOOL_MODULES
