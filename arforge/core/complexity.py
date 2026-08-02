"""v1-1.3：任务复杂度 → 动态 max_steps。

替代硬编码步数：按任务文本的复杂度信号与长度估算迭代上限——简单任务快收、
复杂任务（重构/多文件/迁移）给足步数，避免因步数过低半途被强行收尾。
"""

from __future__ import annotations

SIMPLE_STEPS = 10
MEDIUM_STEPS = 25
COMPLEX_STEPS = 80

# 复杂信号（重构/多文件/迁移/架构/批量）
_COMPLEX_KW = (
    "重构",
    "refactor",
    "迁移",
    "migrate",
    "多文件",
    "整个项目",
    "整个仓库",
    "all files",
    "架构",
    "architecture",
    "重写",
    "rewrite",
    "批量",
    "every file",
    "端到端",
    "end-to-end",
    "完整项目",
    "完整可玩",
    "独立开发",
    "运行验收",
    "最终验收",
    "project delivery",
)
# 中等信号（实现/修复/测试/集成/优化）
_MEDIUM_KW = (
    "实现",
    "implement",
    "添加",
    "新增",
    "feature",
    "功能",
    "修复",
    "fix",
    "debug",
    "测试",
    "test",
    "集成",
    "integrate",
    "优化",
    "optimize",
    "改进",
)


def estimate_max_steps(task: str) -> int:
    """按复杂度返回 max_steps：复杂 80 / 中等 25 / 简单 10。"""
    t = (task or "").lower()
    complex_keywords = _COMPLEX_KW + (
        "重构", "迁移", "多文件", "整个项目", "整个仓库", "架构",
        "重写", "拆分", "提取", "批量", "端到端", "完整项目", "运行验收", "最终验收",
        "split", "extract",
    )
    medium_keywords = _MEDIUM_KW + (
        "实现", "添加", "新增", "功能", "修复", "调试", "测试",
        "集成", "优化", "改进",
    )
    if any(k in t for k in complex_keywords) or len(task or "") > 200:
        return COMPLEX_STEPS
    if any(k in t for k in medium_keywords) or len(task or "") > 80:
        return MEDIUM_STEPS
    return SIMPLE_STEPS
