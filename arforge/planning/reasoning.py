"""Small deterministic reasoning helpers."""

from __future__ import annotations


def classify_task(text: str) -> str:
    lowered = text.lower()
    if any(word in lowered for word in ["bug", "fix", "error", "报错", "修复"]):
        return "fix"
    if any(word in lowered for word in ["plan", "architecture", "设计", "规划", "架构"]):
        return "planning"
    if any(word in lowered for word in ["test", "pytest", "测试"]):
        return "testing"
    return "general"


def reason_about_task(text: str) -> dict:
    category = classify_task(text)
    return {
        "category": category,
        "needs_tests": category in {"fix", "testing", "planning"},
        "needs_code_read": category in {"fix", "planning", "general"},
    }


def build_plan_prompt(user_input: str, context: str = "") -> str:
    return f"Task: {user_input}\nContext:\n{context}".strip()
