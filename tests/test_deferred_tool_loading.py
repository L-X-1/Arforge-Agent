from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest

import arforge.tools.schedule_tools  # noqa: F401
import arforge.tools.tool_search_tools  # noqa: F401
from arforge.core.agentic import run_tool_loop
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.tool_registry import (
    REGISTRY,
    ParamSchema,
    ToolDefinition,
    ToolRegistry,
    ToolSchema,
    deferred_tool_scope,
    register_tool,
    selected_deferred_tools,
    select_deferred_tools,
)


def _names(items: list[dict]) -> set[str]:
    return {item["function"]["name"] for item in items}


def _definition(
    name: str,
    description: str,
    *,
    deferred: bool,
    keywords: list[str] | None = None,
    search_hint: str = "",
) -> ToolDefinition:
    return ToolDefinition(
        name=name,
        description=description,
        schema=ToolSchema(
            name=name,
            description=description,
            params=[ParamSchema("value", required=False, default="")],
            should_defer=deferred,
        ),
        keywords=keywords or [],
        execute_fn=lambda value="": value or name,
        search_hint=search_hint,
    )


def test_legacy_export_remains_full_when_deferred_loading_is_disabled():
    registry = ToolRegistry()
    registry.register(_definition("core_tool", "core", deferred=False))
    registry.register(_definition("heavy_tool", "heavy", deferred=True))

    assert _names(registry.to_openai_tools()) == {"core_tool", "heavy_tool"}
    assert _names(registry.to_openai_tools(deferred=False)) == {"core_tool", "heavy_tool"}
    assert _names(registry.to_openai_tools(deferred=True)) == {"core_tool"}


def test_search_supports_keywords_required_terms_and_exact_selection():
    registry = ToolRegistry()
    registry.register(
        _definition(
            "notebook_edit",
            "Edit notebook cells and metadata.",
            deferred=True,
            keywords=["jupyter", "cells"],
            search_hint="python data science document",
        )
    )
    registry.register(
        _definition(
            "browser_open",
            "Open a browser page.",
            deferred=True,
            keywords=["web"],
            search_hint="interactive page",
        )
    )

    keyword = registry.search_deferred_tools("jupyter +cells")
    exact = registry.search_deferred_tools("select:browser_open,notebook_edit")

    assert [item["name"] for item in keyword["matches"]] == ["notebook_edit"]
    assert [item["name"] for item in exact["matches"]] == ["browser_open", "notebook_edit"]
    assert exact["matches"][0]["schema"]["function"]["name"] == "browser_open"


def test_selected_tools_are_visible_only_inside_the_current_scope():
    registry = ToolRegistry()
    registry.register(_definition("core_tool", "core", deferred=False))
    registry.register(_definition("heavy_tool", "heavy", deferred=True))

    with deferred_tool_scope():
        assert _names(registry.to_openai_tools()) == {"core_tool"}
        select_deferred_tools(["heavy_tool"])
        assert selected_deferred_tools() == frozenset({"heavy_tool"})
        assert _names(registry.to_openai_tools()) == {"core_tool", "heavy_tool"}

        def isolated_worker() -> set[str]:
            with deferred_tool_scope():
                return _names(registry.to_openai_tools())

        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(isolated_worker).result() == {"core_tool"}

    assert selected_deferred_tools() == frozenset()
    assert _names(registry.to_openai_tools()) == {"core_tool", "heavy_tool"}


def test_active_role_filter_limits_search_and_schema_export():
    registry = ToolRegistry()
    registry.register(_definition("allowed_heavy", "allowed capability", deferred=True))
    registry.register(_definition("hidden_heavy", "hidden capability", deferred=True))
    registry.push_filter({"allowed_heavy"})
    try:
        result = registry.search_deferred_tools("capability")
        with deferred_tool_scope():
            select_deferred_tools(["allowed_heavy", "hidden_heavy"])
            visible = _names(registry.to_openai_tools())
    finally:
        registry.pop_filter()

    assert [item["name"] for item in result["matches"]] == ["allowed_heavy"]
    assert visible == {"allowed_heavy"}


class _DiscoveryAdapter:
    model_name = "test"

    def __init__(self) -> None:
        self.calls = 0
        self.tool_sets: list[set[str]] = []

    def generate_with_tools(self, _messages, tools=None, tool_choice="auto"):
        self.calls += 1
        self.tool_sets.append(_names(tools or []))
        if self.calls == 1:
            return ToolCallResponse(
                content="",
                finish_reason="tool_calls",
                tool_calls=[ToolCall("search", "tool_search", '{"query":"select:t60_heavy_tool"}')],
            )
        if self.calls == 2:
            return ToolCallResponse(
                content="",
                finish_reason="tool_calls",
                tool_calls=[ToolCall("heavy", "t60_heavy_tool", "{}")],
            )
        return ToolCallResponse(content="complete", finish_reason="stop", tool_calls=[])


def test_model_can_discover_then_call_a_deferred_tool_on_the_next_step():
    @register_tool(
        "t60_heavy_tool",
        "Temporary heavy tool used to verify next-step activation.",
        params=[],
        source=__name__,
        should_defer=True,
    )
    def _heavy_tool() -> str:
        return json.dumps({"status": "executed"})

    adapter = _DiscoveryAdapter()
    try:
        with deferred_tool_scope():
            result = run_tool_loop(
                adapter,
                [{"role": "user", "content": "discover and run the heavy tool"}],
                tools=REGISTRY.to_openai_tools,
                max_steps=4,
            )
    finally:
        REGISTRY.tools.pop("t60_heavy_tool", None)

    assert "tool_search" in adapter.tool_sets[0]
    assert "t60_heavy_tool" not in adapter.tool_sets[0]
    assert "t60_heavy_tool" in adapter.tool_sets[1]
    assert result.answer == "complete"
    assert [item["tool"] for item in result.tool_calls] == ["tool_search", "t60_heavy_tool"]


@pytest.mark.parametrize("value", [0, 21, True, "many"])
def test_search_rejects_invalid_result_limits(value):
    registry = ToolRegistry()
    registry.register(_definition("heavy_tool", "heavy", deferred=True))

    with pytest.raises(ValueError, match="between 1 and 20"):
        registry.search_deferred_tools("heavy", max_results=value)


def test_heavy_builtin_source_is_deferred_but_tool_search_is_always_loaded():
    schedule = REGISTRY.get("schedule_list")
    discovery = REGISTRY.get("tool_search")

    assert schedule is not None and schedule.schema.should_defer is True
    assert discovery is not None and discovery.schema.always_load is True
