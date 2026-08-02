"""查询变换 — HyDE / 多查询 / 改写 / 分解（RAG 召回增强）。

经典 RAG 直接拿用户问题去检索，常因"问法 ≠ 文档措辞"而漏召回。查询变换在检索前
用 LLM 重写查询，显著提升召回：
- hyde       : 生成"假设答案"文档，用它做向量检索（更贴近真实相关文档的向量空间）。
- multi_query: 生成多个等价改写查询，各自检索后融合（覆盖不同关键词/角度）。
- rewrite    : 把口语/带上下文的问题改写成独立、清晰的检索查询。
- decompose  : 把复杂问题分解为可独立检索的子问题。

所有函数 LLM 驱动 + 稳健解析；任何异常都回退原查询，保证不破坏检索。
adapter 需有 generate(messages, **kwargs) -> str。
"""

from __future__ import annotations

from arforge.models.structured import extract_json

_HYDE_PROMPT = (
    "针对下面的问题，写一段简短的、像是直接摘自资料的“假设答案”段落"
    "（即使不确定也写得具体、含可能的关键术语），仅用于检索相似文档。只输出该段落。\n\n"
    "问题：{q}\n\n假设答案："
)

_MULTI_PROMPT = (
    "把下面的问题改写成 {n} 个语义等价但措辞不同的检索查询（覆盖不同关键词、同义词、角度）。"
    "每行一个，不要编号、不要解释。\n\n问题：{q}"
)

_REWRITE_PROMPT = (
    "把下面（可能含对话上下文或口语）的提问改写成一个独立、清晰、适合检索的查询。"
    "只输出改写后的查询本身。\n\n对话历史：{h}\n\n提问：{q}"
)

_DECOMPOSE_PROMPT = (
    "把下面的复杂问题分解为若干更小、可独立检索的子问题。"
    '以 JSON 输出：{{"subquestions": ["...", "..."]}}。\n\n问题：{q}'
)


def hyde(query: str, adapter, max_tokens: int = 256) -> str:
    """HyDE：生成"假设答案"文档供向量检索；失败回退原查询。"""
    try:
        out = adapter.generate(
            [{"role": "user", "content": _HYDE_PROMPT.format(q=query)}], max_tokens=max_tokens
        )
        return (out or "").strip() or query
    except Exception:
        return query


def multi_query(query: str, adapter, n: int = 3) -> list[str]:
    """多查询扩展：生成 n 个改写查询（不含原查询）；失败回退 []。"""
    try:
        out = adapter.generate([{"role": "user", "content": _MULTI_PROMPT.format(q=query, n=n)}])
    except Exception:
        return []
    variants = []
    for line in (out or "").splitlines():
        v = line.strip().lstrip("-·*0123456789.、) ").strip()
        if v and v != query:
            variants.append(v)
    return variants[:n]


def rewrite(query: str, adapter, history: str = "") -> str:
    """查询改写：口语/带上下文 → 独立检索查询；失败回退原查询。"""
    try:
        out = adapter.generate(
            [{"role": "user", "content": _REWRITE_PROMPT.format(q=query, h=history or "（无）")}]
        )
        return (out or "").strip() or query
    except Exception:
        return query


def decompose(query: str, adapter) -> list[str]:
    """查询分解：复杂问题 → 子问题列表；失败回退 [query]。"""
    prompt = [{"role": "user", "content": _DECOMPOSE_PROMPT.format(q=query)}]
    try:
        try:
            out = adapter.generate(prompt, response_format={"type": "json_object"})
        except TypeError:
            out = adapter.generate(prompt)
    except Exception:
        return [query]
    data = extract_json(out)
    subs: list[str] = []
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, list):
                subs = [str(s).strip() for s in value if str(s).strip()]
                break
    elif isinstance(data, list):
        subs = [str(s).strip() for s in data if str(s).strip()]
    return subs or [query]
