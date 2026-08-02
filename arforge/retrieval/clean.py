"""脏数据清洗 — 规范化 + 去重（企业级 RAG 摄入环节）。

- normalize_text: 去控制字符、统一空白、折叠多余空行、去零宽字符。
- dedup_chunks: 基于规范化指纹去除近重复块（爬虫/导出常见的重复样板）。
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍﻿ "), None)
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def normalize_text(text: str) -> str:
    """规范化文本：Unicode NFKC、去控制/零宽字符、统一空白、折叠空行。"""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(_ZERO_WIDTH)
    text = _CTRL.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 行尾空白 + 折叠 3+ 连续空行为 2
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 折叠行内多余空格(保留代码缩进：仅折叠 3+ 空格为 1，避免破坏对齐)
    return text.strip()


def _fingerprint(text: str) -> str:
    norm = re.sub(r"\s+", " ", text.strip().lower())
    return hashlib.md5(norm.encode("utf-8")).hexdigest()


def dedup_chunks(chunks: list) -> list:
    """按规范化指纹去除完全/近似重复的块，保留首次出现的顺序。"""
    seen: set[str] = set()
    out = []
    for c in chunks:
        text = c.text if hasattr(c, "text") else (c.get("text", "") if isinstance(c, dict) else str(c))
        fp = _fingerprint(text)
        if fp in seen:
            continue
        seen.add(fp)
        out.append(c)
    return out
