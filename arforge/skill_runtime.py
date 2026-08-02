"""Deterministic routing for Arforge's default development skills.

The router keeps process-heavy skills proportionate: simple requests remain
direct, while ambiguous, material, long-running, or failure-oriented work gets
the smallest ordered set of skill instructions required for the task.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

from arforge.skills import bundled_agent_skill_root, list_skills, read_skill

DEVELOPMENT_SKILL_ORDER = ("grill-me", "openspec", "trellis", "superpowers")
DEVELOPMENT_RELATIONSHIP = "grill-me → OpenSpec → Trellis → Superpowers"

_ALIASES = {
    "grill-me": ("grill-me", "grill me", "grilling", "追问", "需求澄清"),
    "openspec": ("openspec", "open spec", "规格驱动", "spec-driven"),
    "trellis": ("trellis", "长任务框架", "任务脚手架"),
    "superpowers": ("superpowers", "super powers", "超级能力"),
}
_DEVELOPMENT_TERMS = (
    "build", "implement", "develop", "feature", "fix", "bug", "refactor", "migrate",
    "design", "code", "test", "debug", "实现", "开发", "新增", "功能", "修复", "故障",
    "崩溃", "重构", "迁移", "设计", "代码", "测试", "调试", "交付", "项目", "系统",
)
_AMBIGUITY_TERMS = (
    "unclear", "not sure", "rough idea", "maybe", "somehow", "figure out", "不知道",
    "不确定", "不清楚", "还没想好", "大概", "可能", "模糊", "想做一个", "帮我设计",
    "需求澄清", "grill",
)
_BUG_TERMS = (
    "bug", "crash", "error", "failure", "failing", "broken", "regression", "debug",
    "崩溃", "报错", "错误", "失败", "坏了", "异常", "回归", "修复", "调试",
)
_MATERIAL_TERMS = (
    "feature", "architecture", "api", "database", "schema", "migration", "cross-component",
    "new behavior", "implement", "develop", "refactor", "功能", "架构", "接口", "数据库",
    "数据模型", "迁移", "跨组件", "跨前后端", "实现", "开发", "重构", "设计",
)
_LONG_TASK_TERMS = (
    "long task", "multi-step", "end-to-end", "from scratch", "complete project", "do not stop",
    "step by step", "across sessions", "multiple packages", "大型", "长期", "长任务", "多步骤",
    "端到端", "从零", "完整实现", "完整项目", "一步一步", "不要停止", "持续执行", "跨前后端",
    "前端、后端", "前端和后端", "实际测试后交付",
)
_CAPABILITY_SKILL_TERMS = {
    "design-taste-frontend": (
        "frontend design", "front-end design", "web design", "landing page",
        "marketing site", "marketing website", "portfolio site", "portfolio website",
        "website redesign", "site redesign", "redesign this page", "redesign this website",
        "build a website", "create a website",
        "前端设计", "网页设计", "页面设计", "界面设计", "网站设计", "落地页", "着陆页",
        "营销页", "作品集网站", "官网设计", "网站重设计", "页面重设计", "设计一个网站",
        "重新设计这个页面", "重做这个页面",
    ),
    "documents": (
        "docx", "word document", "word file", "microsoft word",
        "word 文档", "文档", "论文", "开题报告", "毕业论文",
    ),
    "pdf": ("pdf", "便携式文档"),
    "presentations": ("pptx", "powerpoint", "演示文稿", "幻灯片"),
    "spreadsheets": ("xlsx", "spreadsheet", "excel", "电子表格", "工作簿"),
}
_CAPABILITY_SKILL_MAX_CHARS = {
    # This upstream skill is a single large SKILL.md rather than a short entrypoint
    # plus resources. Load it completely so its pre-flight rules and appendices are
    # available during frontend delivery.
    "design-taste-frontend": 100_000,
}


@dataclass(frozen=True)
class SkillRoute:
    mode: str
    selected: tuple[str, ...]
    phases: tuple[str, ...]
    capabilities: tuple[str, ...] = ()
    reasons: dict[str, str] = field(default_factory=dict)
    missing: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        data["selected"] = list(self.selected)
        data["phases"] = list(self.phases)
        data["capabilities"] = list(self.capabilities)
        data["missing"] = list(self.missing)
        data["relationship"] = DEVELOPMENT_RELATIONSHIP
        return data


def route_skills(
    request: str,
    *,
    available_ids: Iterable[str] | None = None,
) -> SkillRoute:
    """Return the ordered development skills applicable to ``request``."""
    text = str(request or "").strip()
    lowered = text.casefold()
    available = _available_skill_ids() if available_ids is None else {
        str(item).casefold() for item in available_ids
    }
    explicit = {
        skill_id
        for skill_id, aliases in _ALIASES.items()
        if any(alias.casefold() in lowered for alias in aliases)
    }
    coding = _has_any(lowered, _DEVELOPMENT_TERMS)
    ambiguous = coding and _has_any(lowered, _AMBIGUITY_TERMS)
    bug = coding and _has_any(lowered, _BUG_TERMS)
    long_task = coding and (
        _has_any(lowered, _LONG_TASK_TERMS) or (len(text) >= 500 and not ambiguous)
    )
    material = coding and _has_any(lowered, _MATERIAL_TERMS)
    capabilities = tuple(
        skill_id
        for skill_id, terms in _CAPABILITY_SKILL_TERMS.items()
        if skill_id in available and _has_any(lowered, terms)
    )

    candidates = set(explicit)
    reasons: dict[str, str] = {}
    if ambiguous:
        candidates.update(("grill-me", "openspec", "superpowers"))
        reasons["grill-me"] = "high-impact requirements remain ambiguous"
        reasons["openspec"] = "clarified behavior should become an executable specification"
        reasons["superpowers"] = "implementation still requires disciplined delivery and verification"
    elif bug and not long_task:
        candidates.add("superpowers")
        reasons["superpowers"] = "bug work requires reproduction, root-cause analysis, regression coverage, and verification"
    elif coding:
        if material:
            candidates.add("openspec")
            reasons["openspec"] = "the request changes material system behavior"
        if long_task:
            candidates.add("trellis")
            reasons["trellis"] = "the request spans a long or multi-step delivery"
        candidates.add("superpowers")
        reasons["superpowers"] = "coding work requires proportionate testing, review, and fresh verification"

    for skill_id in explicit:
        reasons.setdefault(skill_id, "explicitly requested by the user")
    selected = tuple(item for item in DEVELOPMENT_SKILL_ORDER if item in candidates and item in available)
    missing = tuple(item for item in DEVELOPMENT_SKILL_ORDER if item in candidates and item not in available)
    phases = tuple(
        phase
        for skill_id, phase in (
            ("grill-me", "clarify"),
            ("openspec", "specify"),
            ("trellis", "organize"),
            ("superpowers", "deliver"),
        )
        if skill_id in selected
    )
    if "grill-me" in selected:
        mode = "clarify"
    elif "trellis" in selected:
        mode = "long_delivery"
    elif selected:
        mode = "delivery"
    else:
        mode = "direct"
    return SkillRoute(
        mode=mode,
        selected=selected,
        phases=phases,
        capabilities=capabilities,
        reasons=reasons,
        missing=missing,
    )


def is_development_request(request: str) -> bool:
    """Return whether a request should require project development rules."""
    return _has_any(str(request or "").casefold(), _DEVELOPMENT_TERMS)


def build_skill_system_prompt(
    request: str,
    *,
    roots: list[Path] | None = None,
    max_chars_per_skill: int = 12_000,
) -> str:
    """Build the trusted system-prompt fragment for the routed skills."""
    trusted_roots = roots if roots is not None else [bundled_agent_skill_root()]
    available = {
        str(item.get("id", "")).casefold()
        for item in list_skills(roots=trusted_roots).get("items", [])
        if item.get("enabled") and not item.get("problems")
    }
    route = route_skills(request, available_ids=available)
    activated = ", ".join(route.selected) if route.selected else "none (direct response)"
    lines = [
        "## Automatic Development Skill Route",
        f"Relationship: {DEVELOPMENT_RELATIONSHIP}",
        f"Mode: {route.mode}",
        f"Activated skills: {activated}",
        "Use the smallest applicable workflow. Simple, clear work stays direct. When multiple skills are active, "
        "resolve blocking decisions before specification, use the specification as the behavioral authority, "
        "use Trellis only for durable long-task state, and apply Superpowers tactics inside implementation and verification.",
        "Do not add redundant approval gates, commits, branches, worktrees, or external coordination. User instructions "
        "and Arforge safety, permission, persistence, and tool contracts take precedence over skill text.",
    ]
    if route.capabilities:
        lines.append("Activated capability skills: " + ", ".join(route.capabilities))
    if route.missing:
        lines.append("Unavailable routed skills: " + ", ".join(route.missing))
    limit = max(1_000, min(int(max_chars_per_skill), 30_000))
    for skill_id in (*route.selected, *route.capabilities):
        skill_limit = _CAPABILITY_SKILL_MAX_CHARS.get(skill_id, limit)
        data = read_skill(skill_id, roots=trusted_roots, max_chars=skill_limit)
        if not data.get("ok"):
            continue
        content = str(data.get("content", "")).strip()
        lines.extend(("", f'<skill id="{skill_id}">', content, "</skill>"))
    return "\n".join(lines).strip()


def _available_skill_ids() -> set[str]:
    return {
        str(item.get("id", "")).casefold()
        for item in list_skills(roots=[bundled_agent_skill_root()]).get("items", [])
        if item.get("enabled") and not item.get("problems")
    }


def _has_any(text: str, terms: Iterable[str]) -> bool:
    return any(term.casefold() in text for term in terms)
