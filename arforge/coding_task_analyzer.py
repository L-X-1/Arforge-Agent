"""Coding task analysis."""

from __future__ import annotations


def analyze_coding_task(user_input: str) -> dict:
    text = user_input.lower()
    return {
        "is_coding": any(word in text for word in ["code", "test", "bug", "fix", "代码", "测试", "修复"]),
        "wants_tests": any(word in text for word in ["test", "pytest", "测试"]),
        "wants_review": any(word in text for word in ["review", "审查", "audit"]),
        "wants_edit": any(word in text for word in ["fix", "modify", "write", "修复", "修改"]),
    }
