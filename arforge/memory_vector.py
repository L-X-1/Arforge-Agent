"""向量记忆 — 语义长期记忆 + 压缩（P1-7）。

复用 P1-5 的混合检索（向量 + BM25 + rerank）做相似召回，替代旧 TF-IDF 记忆检索；
并提供记忆压缩（把多条/超长历史摘要成紧凑记忆），控制上下文与 token。
与持久化记忆库 arforge.memory 通过 load_from_store 桥接。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from arforge.retrieval import HybridRetriever, get_embedding_provider


@dataclass
class MemoryEntry:
    id: str
    content: str
    metadata: dict = field(default_factory=dict)


class VectorMemory:
    """语义长期记忆：add() 写入，recall() 按相似度召回（混合检索）。"""

    def __init__(self, embedder=None):
        self._entries: dict[str, MemoryEntry] = {}
        self._retriever = HybridRetriever(embedder=embedder or get_embedding_provider())
        self._dirty = False

    def __len__(self) -> int:
        return len(self._entries)

    def add(self, mem_id: str, content: str, **metadata) -> None:
        self._entries[str(mem_id)] = MemoryEntry(str(mem_id), content, dict(metadata))
        self._dirty = True

    def add_many(self, items: list[tuple[str, str]]) -> None:
        for mem_id, content in items:
            if content:
                self._entries[str(mem_id)] = MemoryEntry(str(mem_id), content)
        self._dirty = True

    def _ensure_index(self) -> None:
        if self._dirty:
            self._retriever.index([(e.id, e.content) for e in self._entries.values()])
            self._dirty = False

    def recall(self, query: str, top_k: int = 5) -> list[dict]:
        """按语义相似度召回最相关的记忆。"""
        if not self._entries:
            return []
        self._ensure_index()
        hits = self._retriever.search(query, top_k=top_k)
        return [
            {
                "id": h["id"],
                "content": self._entries[h["id"]].content,
                "score": h["score"],
                "metadata": self._entries[h["id"]].metadata,
            }
            for h in hits
        ]

    def recall_text(self, query: str, top_k: int = 5, sep: str = "\n") -> str:
        """召回并拼成可注入 prompt 的文本。"""
        return sep.join(m["content"] for m in self.recall(query, top_k=top_k))


def load_from_store(limit: int = 200, *, workspace_path: str = "") -> list[tuple[str, str]]:
    """从持久化记忆库(arforge.memory)载入 (id, content)，喂给 VectorMemory。"""
    from arforge.memory import query_memories

    rows = query_memories(limit=limit, workspace_path=workspace_path)
    out: list[tuple[str, str]] = []
    for i, r in enumerate(rows):
        content = r.get("content", "")
        if content:
            out.append((str(r.get("id", i)), content))
    return out


def build_vector_memory(
    limit: int = 200,
    embedder=None,
    *,
    workspace_path: str = "",
) -> VectorMemory:
    """从持久化记忆库构建一个就绪的 VectorMemory。"""
    vm = VectorMemory(embedder=embedder)
    vm.add_many(load_from_store(limit=limit, workspace_path=workspace_path))
    return vm


# ---------------------------------------------------------------------------
# 记忆压缩
# ---------------------------------------------------------------------------

_COMPRESS_PROMPT = (
    "你是严格的工程上下文压缩器。把下面多条记忆/对话片段压缩成简洁摘要。"
    "必须保留并区分：用户约束、架构决定、人员和偏好、路径与数字配置、已完成验证、"
    "失败状态以及尚未完成的待办。不得把待办写成已完成，不得编造原文没有的事实。"
    "去掉寒暄、重复过程和无结论日志：\n\n{body}\n\n摘要："
)


def compress_memories(
    adapter,
    memories: list[str],
    max_input_chars: int = 6000,
    *,
    focus: str = "",
) -> str:
    """用模型把多条记忆压缩成一条紧凑摘要（控制上下文 / token）。"""
    if not memories:
        return ""
    items = [str(item) for item in memories if item]
    if not items:
        return ""
    # Sample the full time range instead of keeping only the oldest prefix. If
    # there are too many entries to give each one a useful slice, select evenly
    # spaced entries including both endpoints. This prevents the final hard cap
    # from silently deleting every late decision/TODO in very long tool runs.
    max_items = max(1, max_input_chars // 80)
    if len(items) > max_items:
        if max_items == 1:
            items = [items[-1]]
        else:
            indices = [round(index * (len(items) - 1) / (max_items - 1)) for index in range(max_items)]
            items = [items[index] for index in dict.fromkeys(indices)]
    separators = max(0, len(items) - 1) * 5
    per_item = max(40, (max_input_chars - separators) // len(items))
    sampled = [item if len(item) <= per_item else item[: per_item - 1].rstrip() + "…" for item in items]
    body = "\n---\n".join(sampled)
    if len(body) > max_input_chars:
        body = body[:max_input_chars]
    focus_text = " ".join(str(focus or "").split())[:1_000]
    prompt = _COMPRESS_PROMPT.format(body=body)
    if focus_text:
        prompt += (
            "\n\nUser-specified preservation focus (keep this material when it exists; "
            f"do not invent it): {focus_text}"
        )
    try:
        return (adapter.generate([{"role": "user", "content": prompt}]) or "").strip()
    except Exception as exc:  # noqa: BLE001
        return f"[记忆压缩失败: {exc}]"
