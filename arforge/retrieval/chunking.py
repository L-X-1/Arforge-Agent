"""智能分块 — 结构感知 + token 感知 + 重叠 + Contextual 前缀（企业级 RAG）。

策略：先按结构边界（markdown 标题 / 代码围栏 / 空行段落）切成语义段，
再按 token 上限打包并加重叠，避免把段落/代码块从中间劈开。
无 tiktoken 时用启发式 token 估算（CJK ~1 token/字，其余 ~1 token/4 字符）。
contextualize 实现轻量 Contextual Retrieval（给每块前置来源/位置上下文供嵌入）。
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field


@dataclass
class Chunk:
    id: str
    text: str
    source: str = ""
    metadata: dict = field(default_factory=dict)

    def embed_text(self) -> str:
        """供嵌入用的文本（含 contextual 前缀，若有）。"""
        return self.metadata.get("contextual_prefix", "") + self.text


def estimate_tokens(text: str) -> int:
    """启发式 token 估算（无 tiktoken 依赖）。"""
    if not text:
        return 0
    cjk = len(re.findall(r"[一-鿿]", text))
    non_cjk = len(re.sub(r"[一-鿿]", "", text))
    return cjk + max(0, non_cjk // 4)


def _split_structural(text: str) -> list[str]:
    """按结构边界切段：代码围栏整体保留；其余按空行分段。"""
    parts: list[str] = []
    for seg in re.split(r"(```.*?```)", text, flags=re.S):
        if seg.startswith("```"):
            parts.append(seg.strip())
        else:
            for para in re.split(r"\n\s*\n", seg):
                para = para.strip()
                if para:
                    parts.append(para)
    return parts


def _split_long(seg: str, max_tokens: int) -> list[str]:
    """把超长段按句子边界硬切到 max_tokens 以内（中文标点后常无空格，故不强制空白）。"""
    sentences = [s for s in re.split(r"(?<=[。！？.!?])", seg) if s.strip()]
    out: list[str] = []
    cur: list[str] = []
    ct = 0
    for s in sentences:
        st = estimate_tokens(s)
        if st > max_tokens:
            # 单句仍超长（无标点的长串）→ 按字符硬切
            if cur:
                out.append("".join(cur))
                cur, ct = [], 0
            step = max(1, max_tokens * 2)
            out.extend(s[i : i + step] for i in range(0, len(s), step))
            continue
        if ct + st > max_tokens and cur:
            out.append("".join(cur))
            cur, ct = [], 0
        cur.append(s)
        ct += st
    if cur:
        out.append("".join(cur))
    return out or [seg]


def _mk_chunk(body: str, source: str, index: int) -> Chunk:
    cid = hashlib.md5(f"{source}|{index}|{body[:80]}".encode()).hexdigest()[:12]
    return Chunk(id=cid, text=body, source=source, metadata={"tokens": estimate_tokens(body), "index": index})


def chunk_text(text: str, *, source: str = "", max_tokens: int = 400, overlap_tokens: int = 60, min_tokens: int = 16) -> list[Chunk]:
    """把文本切成带重叠的 token 感知块。"""
    segments = _split_structural(text)
    chunks: list[Chunk] = []
    cur: list[str] = []
    cur_tok = 0

    def emit() -> None:
        nonlocal cur, cur_tok
        body = "\n\n".join(cur).strip()
        if body and estimate_tokens(body) >= min_tokens:
            chunks.append(_mk_chunk(body, source, len(chunks)))
        cur, cur_tok = [], 0

    for seg in segments:
        st = estimate_tokens(seg)
        if st > max_tokens:
            emit()
            for piece in _split_long(seg, max_tokens):
                chunks.append(_mk_chunk(piece, source, len(chunks)))
            continue
        if cur_tok + st > max_tokens and cur:
            emit()
            # 重叠：保留上一窗口尾部累计约 overlap_tokens 的段落
            keep: list[str] = []
            kt = 0
            for s in reversed(chunks[-1].text.split("\n\n") if chunks else []):
                if kt >= overlap_tokens:
                    break
                keep.insert(0, s)
                kt += estimate_tokens(s)
            cur, cur_tok = keep[:], kt
        cur.append(seg)
        cur_tok += st
    emit()
    return chunks or ([_mk_chunk(text.strip(), source, 0)] if text.strip() else [])


def contextualize(chunks: list[Chunk], doc_title: str = "", llm_context_fn=None) -> list[Chunk]:
    """轻量 Contextual Retrieval：给每块前置来源/位置上下文（供嵌入，不改显示文本）。

    完整版用 LLM 为每块生成上下文；传入 llm_context_fn(chunk)->str 即启用，
    否则用零成本的确定性前缀（来源 + 第几块）。
    """
    for c in chunks:
        if llm_context_fn is not None:
            try:
                ctx = llm_context_fn(c)
            except Exception:
                ctx = ""
        else:
            title = doc_title or c.source
            ctx = f"[来源:{title} 第{c.metadata.get('index', 0) + 1}块] " if title else ""
        c.metadata["contextual_prefix"] = ctx
    return chunks
