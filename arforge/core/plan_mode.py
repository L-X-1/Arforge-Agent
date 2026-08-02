"""v1-1.4：Plan Mode 真落地——先出方案 → 确认 → 执行。

plan 模式：agent 只读探索并产出结构化方案（写操作被三模式权限拦截）；CLI 展示
方案后请求批准，批准则切到 acceptEdits 执行该任务。形成 plan→执行闭环。
"""

from __future__ import annotations

import os
import re
import sys
from typing import Any

PLAN_GUIDE = (
    "## Plan 模式（只读，重要）\n"
    "你当前处于 plan 模式：只能探索（读文件 / 搜代码 / 列目录 / 派只读子代理），"
    "不要写或改文件、不要执行命令——这些会被权限拒绝。\n"
    "先调查清楚，然后给出**结构化方案**作为最终回答，包含：\n"
    "1) 目标；2) 涉及/将改动的文件；3) 分步执行计划；4) 风险与是否可回滚。\n"
    "给出方案后即结束，等待用户批准。"
)


def auto_approved() -> bool:
    """环境变量 ARFORGE_AUTO_APPROVE 视为已批准（CI/自动化）。"""
    return os.environ.get("ARFORGE_AUTO_APPROVE", "").strip().lower() in ("1", "true", "yes", "on")


def _stdin_is_tty() -> bool:
    try:
        return bool(sys.stdin.isatty())
    except Exception:  # noqa: BLE001
        return False


def read_approval(read_fn=input) -> bool:
    """读取用户批准（y/yes/是）。EOF/中断 → False。"""
    try:
        ans = read_fn("  批准执行此方案？[y/N] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        return False
    return ans in ("y", "yes", "是")


def approval_decision(read_fn=input) -> bool:
    """方案是否获批：auto-approve → True；可交互 → 询问；非交互 → False（安全默认）。"""
    if auto_approved():
        return True
    if not _stdin_is_tty():
        return False
    return read_approval(read_fn)


def read_approval_action(read_fn=input) -> str:
    """Return approve/reject/edit from a CLI approval prompt."""
    try:
        ans = read_fn("  Approve this plan? [y/N/e] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        return "reject"
    if ans in ("y", "yes"):
        return "approve"
    if ans in ("e", "edit"):
        return "edit"
    return "reject"


_FILE_TOKEN = re.compile(
    r"(?<![\w.-])(?:[A-Za-z]:[\\/])?[\w.@:+-]+(?:[\\/][\w.@:+-]+)+\.[A-Za-z0-9]{1,12}(?![\w-])"
)
_BULLET = re.compile(r"^\s*(?:[-*]|\d+[.)])\s+(?P<text>.+?)\s*$")
_RISK_WORDS = ("risk", "risks")
_ROLLBACK_WORDS = ("rollback", "revert", "undo")


def _dedupe(values: list[str], *, limit: int) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for raw in values:
        item = str(raw).strip()
        if not item or item in seen:
            continue
        seen.add(item)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def _extract_bullets(text: str, *, limit: int) -> list[str]:
    items: list[str] = []
    for line in text.splitlines():
        match = _BULLET.match(line)
        if match:
            items.append(match.group("text")[:240])
    return _dedupe(items, limit=limit)


def build_structured_plan(
    task: str,
    plan_text: str,
    *,
    explored_files: list[str] | None = None,
    estimated_steps: int | None = None,
) -> dict[str, Any]:
    """Normalize a plan-mode answer into the UI/Bridge JSON contract.

    The builder is deterministic and side-effect free: it never approves work,
    changes permission mode, or writes files. It only makes a plan auditable and
    renderable by CLI/Desktop surfaces.
    """
    clean_task = str(task or "").strip()
    raw_plan = str(plan_text or "").strip()
    if not clean_task:
        raise ValueError("task must not be empty")
    if not raw_plan:
        raise ValueError("plan_text must not be empty")
    if len(clean_task) > 2000:
        raise ValueError("task must be at most 2000 characters")
    if len(raw_plan) > 20000:
        raise ValueError("plan_text must be at most 20000 characters")
    if estimated_steps is not None and (estimated_steps < 1 or estimated_steps > 100):
        raise ValueError("estimated_steps must be between 1 and 100")

    first_line = next((line.strip(" #\t") for line in raw_plan.splitlines() if line.strip()), "")
    files = _dedupe([*(explored_files or []), *_FILE_TOKEN.findall(raw_plan)], limit=50)
    bullets = _extract_bullets(raw_plan, limit=24) or [first_line[:240]]
    lowered_lines = [(line, line.lower()) for line in raw_plan.splitlines()]
    risks = [line.strip()[:240] for line, low in lowered_lines if any(word in low for word in _RISK_WORDS)]
    rollback = [line.strip()[:240] for line, low in lowered_lines if any(word in low for word in _ROLLBACK_WORDS)]

    return {
        "schema_version": 1,
        "mode": "plan",
        "approval_required": True,
        "execution_mode_after_approval": "acceptEdits",
        "task": clean_task,
        "summary": first_line[:300],
        "affected_files": files,
        "steps": [{"index": index + 1, "content": content, "status": "pending"} for index, content in enumerate(bullets)],
        "risks": _dedupe(risks, limit=10),
        "rollback": _dedupe(rollback, limit=10),
        "estimated_steps": estimated_steps or len(bullets),
        "raw_plan": raw_plan,
    }
