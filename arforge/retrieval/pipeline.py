"""企业级 RAG 管线（端到端）。

解析 → 清洗去重 → 智能分块(+Contextual 前缀) → 嵌入 → 混合索引(BM25+向量) →
检索 → 重排(cross-encoder/lexical) → 带溯源引用的 grounded 答案生成。

把 P1-5 检索核心与摄入前端(loaders/clean/chunking)、重排(reranker)、grounded 生成串起来；
答案附带 Citation(chunk id + 来源 + 片段 + 分数)，并强制模型只依据资料作答、用 [id] 标注。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from arforge.retrieval.chunking import chunk_text, contextualize
from arforge.retrieval.clean import dedup_chunks, normalize_text
from arforge.retrieval.embedding import get_embedding_provider
from arforge.retrieval.hybrid import HybridRetriever
from arforge.retrieval.reranker import get_reranker


@dataclass
class Citation:
    id: str
    source: str
    snippet: str
    score: float


@dataclass
class RAGAnswer:
    answer: str
    citations: list = field(default_factory=list)
    contexts: list = field(default_factory=list)


_GROUNDED_PROMPT = (
    "你是严谨的检索问答助手。只能依据下面带标号的资料回答问题；"
    "在每条引用到的事实后用 [id] 标注来源；若资料不足以回答，明确说“资料中没有相关信息”，"
    "绝不编造。\n\n资料：\n{context}\n\n问题：{query}\n\n答案（含 [id] 引用）："
)


class RAGPipeline:
    """可复用的端到端 RAG 管线。ingest_* 摄入，retrieve 检索，answer 生成带引用答案。"""

    def __init__(self, embedder=None, reranker=None, use_contextual: bool = True):
        self.embedder = embedder or get_embedding_provider()
        # 召回交给 HybridRetriever（不在其内部 rerank），精排由本类的 reranker 负责
        self.retriever = HybridRetriever(embedder=self.embedder, use_rerank=False)
        self.reranker = reranker or get_reranker("lexical")
        self.use_contextual = use_contextual
        self._chunks: dict = {}

    # -- 摄入 ----------------------------------------------------------------

    def ingest_text(self, text: str, source: str = "inline", **chunk_kwargs) -> int:
        chunks = chunk_text(normalize_text(text), source=source, **chunk_kwargs)
        if self.use_contextual:
            contextualize(chunks, doc_title=source)
        return self._index(chunks)

    def ingest_documents(self, raw_docs, **chunk_kwargs) -> int:
        all_chunks = []
        for doc in raw_docs:
            if not getattr(doc, "text", ""):
                continue
            cs = chunk_text(normalize_text(doc.text), source=doc.source, **chunk_kwargs)
            if self.use_contextual:
                contextualize(cs, doc_title=doc.source)
            all_chunks.extend(cs)
        return self._index(all_chunks)

    def _index(self, chunks) -> int:
        chunks = dedup_chunks(chunks)
        for c in chunks:
            self._chunks[c.id] = c
        # 用 embed_text()（含 contextual 前缀）建索引；显示/引用用原 text
        self.retriever.index([(c.id, c.embed_text()) for c in self._chunks.values()])
        return len(chunks)

    # -- 检索 + 答案 ---------------------------------------------------------

    def retrieve(self, query: str, top_k: int = 5, pool: int = 20, *, adapter=None, transform: str = "none") -> list[dict]:
        """混合召回 pool 个候选 → 精排取 top_k。

        transform（需传 adapter，做查询变换提升召回）：
        - none : 直接用原查询（默认，行为不变）。
        - hyde : 生成"假设文档"做向量召回（BM25 仍用原查询）。
        - multi: 生成多个改写查询，各自检索后 RRF 融合。
        """
        if transform == "hyde" and adapter is not None:
            from arforge.retrieval.query_transform import hyde

            hits = self.retriever.search_dual(bm25_query=query, embed_query=hyde(query, adapter), top_k=pool, pool=pool)
        elif transform == "multi" and adapter is not None:
            from arforge.retrieval.query_transform import multi_query

            hits = self.retriever.search_multi([query, *multi_query(query, adapter)], top_k=pool, pool=pool)
        else:
            hits = self.retriever.search(query, top_k=pool, pool=pool)
        candidates = [(h["id"], self._chunks[h["id"]].text) for h in hits]
        reranked = self.reranker.rerank(query, candidates, top_k)
        return [
            {"id": cid, "score": score, "text": self._chunks[cid].text, "source": self._chunks[cid].source}
            for cid, score in reranked
        ]

    def answer(self, query: str, adapter, top_k: int = 5) -> RAGAnswer:
        """检索 → 重排 → grounded 生成；返回带溯源引用的答案。"""
        contexts = self.retrieve(query, top_k=top_k)
        if not contexts:
            return RAGAnswer(answer="资料中没有相关信息。", citations=[], contexts=[])

        context_block = "\n\n".join(f"[{c['id']}] (来源:{c['source']})\n{c['text']}" for c in contexts)
        prompt = _GROUNDED_PROMPT.format(context=context_block, query=query)
        try:
            text = adapter.generate([{"role": "user", "content": prompt}])
        except Exception as exc:  # noqa: BLE001
            text = f"[生成失败] {exc}"

        citations = [
            Citation(id=c["id"], source=c["source"], snippet=c["text"][:160], score=round(float(c["score"]), 4))
            for c in contexts
        ]
        return RAGAnswer(answer=text or "", citations=citations, contexts=contexts)
