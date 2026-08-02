"""Read-only tools for Arforge Skills."""

from __future__ import annotations

import json

from arforge.skill_runtime import route_skills
from arforge.skills import read_skill
from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "skill_read",
    "Read an enabled Arforge Skill's instructions by skill id. Use before applying a specialized skill.",
    keywords=["skill", "skills", "SKILL.md"],
    params=[
        ParamSchema("skill_id", "string", "Skill id, for example pdf, xlsx, frontend-design, or model-api."),
        ParamSchema("max_chars", "int", "Maximum instruction characters to return.", required=False, default=60000),
    ],
    priority=45,
    risk="low",
    source=__name__,
    category="read",
)
def skill_read(skill_id: str, max_chars: int = 60000) -> str:
    data = read_skill(skill_id, max_chars=max(1000, min(int(max_chars), 120000)))
    return json.dumps(data, ensure_ascii=False, indent=2)


@register_tool(
    "skill_route",
    "Explain which enabled Arforge development skills apply to a request and their execution order.",
    keywords=["workflow", "plan", "develop", "技能路由", "流程", "开发"],
    params=[ParamSchema("request", "string", "The development request to classify.")],
    priority=44,
    risk="low",
    source=__name__,
    category="read",
)
def skill_route(request: str) -> str:
    return json.dumps(route_skills(request).to_dict(), ensure_ascii=False, indent=2)
