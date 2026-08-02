"""Intent analysis helpers."""

from __future__ import annotations

from dataclasses import dataclass

from arforge.planning.reasoning import classify_task


@dataclass
class Intent:
    category: str
    needs_tool: bool = False
    needs_plan: bool = False
    needs_memory: bool = False


def analyze_intent(user_input: str) -> Intent:
    category = classify_task(user_input)
    lowered = user_input.lower()
    tool_keywords = [
        "read", "write", "run", "file", "执行", "文件",
        "calculate", "计算", "compute",
        "time", "时间", "几点", "date",
        "task", "todo", "任务", "待办",
        "list files", "列出", "cmd", "command",
    ]
    return Intent(
        category=category,
        needs_tool=any(word in lowered for word in tool_keywords),
        needs_plan=category == "planning",
        needs_memory=any(word in lowered for word in ["remember", "memory", "记忆", "记住"]),
    )
