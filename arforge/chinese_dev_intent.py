"""Chinese development intent detection."""

from __future__ import annotations


def analyze_chinese_dev_requirement(requirement_text: str) -> dict:
    text = requirement_text
    return {
        "create": any(word in text for word in ["新建", "创建", "添加", "实现"]),
        "modify": any(word in text for word in ["修改", "修复", "替换", "更新"]),
        "test": any(word in text for word in ["测试", "验证", "检查"]),
        "review": any(word in text for word in ["审查", "审核", "评估"]),
    }


def list_chinese_dev_intents(limit: int = 20):
    return ["create", "modify", "test", "review"][:limit]
