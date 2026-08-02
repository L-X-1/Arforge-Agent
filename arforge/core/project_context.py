"""G1：发现并加载被操作项目的约定文件（AGENTS.md / 项目约定文件 / .arforgerules）。

逐级发现约定文件：从 start_dir 向上逐级查找项目约定文件，
就近优先，注入 `arforge code` 流程的系统提示，让 agent 换到任意项目都遵守
该项目自己的规矩。

与 ``prompt.py`` 加载的本仓 ARFORGE.md（Arforge 自身行为准则）互补、不冲突：
那是"Arforge 怎么思考"，这是"当前被操作项目有什么规矩"。
"""

from __future__ import annotations

from pathlib import Path

# 约定文件名（按优先级；同名就近优先，上层不覆盖下层）
_CONVENTION_NAMES = ("AGENTS.md", ".arforgerules", ".cursorrules")
_MAX_LEVELS = 4  # 从 start_dir 起向上最多看几层
_MAX_CHARS = 6000  # 注入系统提示的总字数上限（防止吃满上下文）


def discover_project_conventions(
    start_dir, max_levels: int = _MAX_LEVELS, max_chars: int = _MAX_CHARS
) -> str:
    """逐级向上发现约定文件，返回可直接注入 system 的文本（无则返回 ""）。

    就近优先：start_dir 处的同名文件优先；更上层的同名文件不再重复注入。
    """
    try:
        base = Path(start_dir).resolve()
    except (OSError, ValueError):
        return ""

    found: list[tuple[Path, str]] = []
    seen_names: set[str] = set()
    for level, cur in enumerate([base, *base.parents]):
        if level >= max_levels:
            break
        for name in _CONVENTION_NAMES:
            if name in seen_names:
                continue  # 就近优先：下层已有，跳过上层同名
            p = cur / name
            if p.is_file():
                try:
                    text = p.read_text(encoding="utf-8", errors="replace").strip()
                except OSError:
                    continue
                if text:
                    found.append((p, text))
                    seen_names.add(name)

    if not found:
        return ""

    parts = ["## 本项目约定（务必遵守，来自项目内的约定文件）"]
    total = 0
    for p, text in found:
        remaining = max_chars - total
        if remaining <= 0:
            break
        snippet = text if len(text) <= remaining else text[:remaining] + "\n…(已截断)"
        parts.append(f"### {p.name}\n{snippet}")
        total += len(snippet)
    return "\n\n".join(parts)
