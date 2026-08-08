"""长期记忆按类别整理为可读文档（memory digest）。

从本地记忆库读取 active 长期记忆，按 mem_type 类别分组，生成 Markdown 文档：
用户身份信息、偏好与习惯、项目约定、工作流、约束规则、客观事实、错误模式、
项目信息、知识等；可指定单一类别查看，也可输出结构化 JSON 供其他界面消费。
"""

from __future__ import annotations

import os
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

REFRESH_MIN_INTERVAL_SECONDS = 60.0

_LAST_REFRESH_AT: float = 0.0


def _reset_refresh_throttle() -> None:
    """测试辅助：清除刷新节流状态。"""
    global _LAST_REFRESH_AT
    _LAST_REFRESH_AT = 0.0

CATEGORY_LABELS: dict[str, str] = {
    "identity": "用户身份信息",
    "preference": "偏好与习惯",
    "convention": "项目约定与规范",
    "workflow": "工作流",
    "constraint": "约束与规则",
    "fact": "客观事实",
    "error": "错误模式",
    "error_pattern": "错误模式",
    "pattern": "错误模式",
    "project": "项目信息",
    "knowledge": "知识",
}

CATEGORY_ORDER: tuple[str, ...] = (
    "identity",
    "preference",
    "convention",
    "workflow",
    "constraint",
    "fact",
    "error",
    "error_pattern",
    "pattern",
    "project",
    "knowledge",
)


def _category_of(mem_type: str) -> str:
    kind = str(mem_type or "knowledge").strip().casefold()
    if kind in CATEGORY_LABELS:
        return kind
    return "knowledge"


def _category_label(category: str) -> str:
    return CATEGORY_LABELS.get(category, CATEGORY_LABELS.get("knowledge", "知识"))


def _category_name(category: str) -> str:
    """返回文档中显示的类别名（含中文标签）。"""
    return f"{category} · {_category_label(category)}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_memory_items(
    *,
    project_id: str = "",
    workspace_path: str = "",
    limit: int = 1000,
) -> list[dict[str, Any]]:
    """读取 active 长期记忆（Python 记忆库），失败时返回空列表。"""
    try:
        from arforge.memory import query_memories

        return query_memories(
            limit=limit,
            project_id=project_id,
            workspace_path=workspace_path,
        )
    except Exception:
        return []


def group_by_category(items: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """按类别分组，类别内按重要性降序、时间倒序。"""
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        category = _category_of(str(item.get("mem_type", "knowledge")))
        groups[category].append(item)
    for category in groups:
        groups[category].sort(
            key=lambda entry: (
                int(entry.get("importance", 1) or 1),
                str(entry.get("created_at", "") or ""),
            ),
            reverse=True,
        )
    return dict(groups)


def _entry_line(item: dict[str, Any]) -> str:
    importance = min(max(int(item.get("importance", 1) or 1), 1), 5)
    stars = "★" * importance
    content = str(item.get("content", "") or "").strip()
    lines: list[str] = []
    lines.append(f"- {content}")
    details: list[str] = [f"重要性 {stars}"]
    if item.get("source"):
        details.append(f"来源 {item['source']}")
    if item.get("created_at"):
        details.append(f"记录于 {item['created_at']}")
    tags = str(item.get("tags", "") or "").strip()
    if tags:
        details.append(f"标签 {tags}")
    if item.get("workspace_path"):
        details.append(f"工作区 {item['workspace_path']}")
    if item.get("project_id"):
        details.append(f"项目 {item['project_id']}")
    lines.append(f"  ({'; '.join(details)})")
    return "\n".join(lines)


def render_markdown(
    groups: dict[str, list[dict[str, Any]]],
    *,
    category_filter: str = "",
    title: str = "Arforge 长期记忆档案",
) -> str:
    """按类别渲染为 Markdown 文档。"""
    if category_filter:
        groups = {
            key: value
            for key, value in groups.items()
            if key == category_filter or _category_of(category_filter) == key
        }
    ordered_keys = [key for key in CATEGORY_ORDER if key in groups]
    ordered_keys += sorted(set(groups) - set(ordered_keys))

    total = sum(len(items) for items in groups.values())
    counts = {key: len(items) for key, items in groups.items()}
    lines: list[str] = [
        f"# {title}",
        "",
        f"> 生成时间：{_now_iso()}  ·  共 {total} 条长期记忆",
        "",
    ]
    if counts:
        lines.append("## 类别概览")
        lines.append("")
        lines.append("| 类别 | 条数 |")
        lines.append("|---|---|")
        for key in ordered_keys:
            lines.append(f"| {_category_name(key)} | {counts[key]} |")
        lines.append("")
    for key in ordered_keys:
        lines.append(f"## {_category_name(key)}（{counts[key]} 条）")
        lines.append("")
        for item in groups[key]:
            lines.append(_entry_line(item))
            lines.append("")
    return "\n".join(lines)


def digest_report(
    *,
    project_id: str = "",
    workspace_path: str = "",
    category_filter: str = "",
    limit: int = 1000,
) -> dict[str, Any]:
    """结构化记忆档案报告（JSON 友好）。"""
    items = load_memory_items(
        project_id=project_id,
        workspace_path=workspace_path,
        limit=limit,
    )
    groups = group_by_category(items)
    if category_filter:
        requested = category_filter.strip().casefold()
        groups = {
            key: value
            for key, value in groups.items()
            if key == requested or requested in CATEGORY_LABELS and _category_of(requested) == key
        }
    categories = []
    for key, group in groups.items():
        categories.append(
            {
                "category": key,
                "label": _category_label(key),
                "count": len(group),
                "items": [
                    {
                        "content": str(item.get("content", "") or ""),
                        "mem_type": str(item.get("mem_type", "knowledge") or "knowledge"),
                        "importance": int(item.get("importance", 1) or 1),
                        "source": str(item.get("source", "") or ""),
                        "tags": str(item.get("tags", "") or ""),
                        "created_at": str(item.get("created_at", "") or ""),
                        "project_id": str(item.get("project_id", "") or ""),
                        "workspace_path": str(item.get("workspace_path", "") or ""),
                    }
                    for item in group
                ],
            }
        )
    categories.sort(
        key=lambda entry: CATEGORY_ORDER.index(entry["category"])
        if entry["category"] in CATEGORY_ORDER
        else len(CATEGORY_ORDER)
    )
    return {
        "schema_version": 1,
        "generated_at": _now_iso(),
        "total": sum(entry["count"] for entry in categories),
        "category_count": len(categories),
        "categories": categories,
    }


def default_digest_path() -> str:
    """返回 profile 内的固定档案路径（{ARFORGE_HOME}/memory-digest.md）。"""

    base = os.environ.get("ARFORGE_HOME", os.path.expanduser("~/.arforge"))
    return os.path.join(base, "memory-digest.md")


def write_digest_markdown(path: str, *, category_filter: str = "") -> str:
    """生成 Markdown 文档并写入文件，返回写入路径。"""
    items = load_memory_items(limit=1000)
    groups = group_by_category(items)
    document = render_markdown(groups, category_filter=category_filter)
    from pathlib import Path

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(document, encoding="utf-8")
    return str(target)


def refresh_digest_file(*, force: bool = False) -> str | None:
    """记忆变化后刷新 profile 内的记忆档案文件（带节流）。

    每次写入记忆都会调用本函数；60 秒内的重复调用直接跳过，避免高频对话
    造成无意义的全量重生成。返回实际写入的路径；节流跳过或失败返回 None。
    任何异常都被吞掉——刷新绝不能影响记忆写入主流程。
    """
    global _LAST_REFRESH_AT
    now = time.monotonic()
    if not force and now - _LAST_REFRESH_AT < REFRESH_MIN_INTERVAL_SECONDS:
        return None
    try:
        target = write_digest_markdown(default_digest_path())
        _LAST_REFRESH_AT = now
        return target
    except Exception:
        return None


__all__ = [
    "CATEGORY_LABELS",
    "CATEGORY_ORDER",
    "digest_report",
    "group_by_category",
    "load_memory_items",
    "render_markdown",
    "write_digest_markdown",
]
