"""Deferred tool discovery for large agent capability sets."""

from __future__ import annotations

import json

from arforge.tool_registry import (
    REGISTRY,
    ParamSchema,
    register_tool,
    select_deferred_tools,
)


@register_tool(
    "tool_search",
    (
        "Find tools that are not currently loaded. Use natural-language keywords, "
        "+required terms, an exact tool name, or select:name_a,name_b. Matching "
        "tools become callable on the next model step."
    ),
    params=[
        ParamSchema(
            "query",
            "string",
            "keywords, +required terms, exact tool name, or select:name_a,name_b",
        ),
        ParamSchema(
            "max_results",
            "int",
            "maximum number of matching tool schemas to load (1-20)",
            required=False,
            default=8,
        ),
    ],
    risk="medium",
    timeout=10,
    category="read",
    source=__name__,
    should_defer=False,
    always_load=True,
    search_hint="discover load activate deferred tools by capability",
)
def tool_search(query: str, max_results: int = 8) -> str:
    result = REGISTRY.search_deferred_tools(query, max_results=max_results)
    selected = select_deferred_tools([item["name"] for item in result["matches"]])
    result["selected"] = sorted(selected)
    result["instruction"] = (
        "The matched tool schemas are active for this run and can be called on "
        "the next model step."
    )
    return json.dumps(result, ensure_ascii=False, indent=2)
