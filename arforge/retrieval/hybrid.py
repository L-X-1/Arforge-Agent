"""混合检索 — BM25 + 向量，RRF 融合 + rerank（P1-5）。

相比纯 TF-IDF：向量补语义召回、BM25 保关键词精确，RRF 融合两路排名，
最后用 rerank 对候选精排。无 cross-encoder 时用离线 lexical rerank 兜底。
"""

from __future__ import annotations

import re

from arforge.retrieval.embedding import EmbeddingProvider, get_embedding_provider
from arforge.retrieval.vector_store import VectorStore


def tokenize(text: str) -> list[str]:
    """代码友好分词：标识符 + 拆下划线/驼峰，提升关键词召回。"""
    tokens = re.findall(r"[A-Za-z0-9_]+", text.lower())
    out: list[str] = []
    for tok in tokens:
        out.append(tok)
        out.extend(p for p in tok.split("_") if p)
        out.extend(p.lower() for p in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+", tok) if p)
    return out or [text.lower()]


def reciprocal_rank_fusion(rankings: list[list[str]], k: int = 60) -> dict[str, float]:
    """RRF：对多路排名按 1/(k+rank) 求和融合（rank 从 0 计）。"""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)
    return scores


def lexical_rerank(query: str, candidates: list[tuple[str, str]], top_n: int) -> list[tuple[str, float]]:
    """离线 rerank：查询词覆盖度 / sqrt(文档独立词数)，惩罚冗长文档。"""
    q_tokens = set(tokenize(query))
    scored: list[tuple[str, float]] = []
    for doc_id, text in candidates:
        d_tokens = tokenize(text)
        if not d_tokens:
            scored.append((doc_id, 0.0))
            continue
        overlap = sum(1 for t in d_tokens if t in q_tokens)
        scored.append((doc_id, overlap / (len(set(d_tokens)) ** 0.5 + 1e-9)))
    scored.sort(key=lambda x: -x[1])
    return scored[:top_n]


class HybridRetriever:
    """混合检索器：index(documents) 后 search(query)。"""

    def __init__(self, embedder: EmbeddingProvider | None = None, use_rerank: bool = True):
        self.embedder = embedder or get_embedding_provider()
        self.use_rerank = use_rerank
        self._docs: dict[str, str] = {}
        self._ids: list[str] = []
        self._bm25 = None
        self._vstore: VectorStore | None = None

    def index(self, documents: list[tuple[str, str]]) -> None:
        """documents: [(id, text), ...]"""
        from rank_bm25 import BM25Okapi

        self._docs = dict(documents)
        self._ids = [doc_id for doc_id, _ in documents]
        if not documents:
            self._bm25 = None
            self._vstore = None
            return

        self._bm25 = BM25Okapi([tokenize(text) for _, text in documents])
        vectors = self.embedder.embed([text for _, text in documents])
        self._vstore = VectorStore(self.embedder.dim)
        self._vstore.add(self._ids, vectors)

    def _bm25_rank(self, query: str, k: int) -> list[str]:
        if self._bm25 is None:
            return []
        scores = self._bm25.get_scores(tokenize(query))
        order = sorted(range(len(scores)), key=lambda i: -scores[i])
        return [self._ids[i] for i in order[:k] if scores[i] > 0]

    def _vector_rank(self, query: str, k: int) -> list[str]:
        if self._vstore is None or len(self._vstore) == 0:
            return []
        qv = self.embedder.embed_one(query)
        return [doc_id for doc_id, _ in self._vstore.search(qv, k)]

    def search(self, query: str, top_k: int = 5, pool: int = 20) -> list[dict]:
        """混合检索：BM25 ∪ 向量 → RRF 融合 → rerank → top_k。"""
        bm25_ids = self._bm25_rank(query, pool)
        vec_ids = self._vector_rank(query, pool)
        fused = reciprocal_rank_fusion([bm25_ids, vec_ids])
        if not fused:
            return []
        ranked = sorted(fused, key=lambda d: -fused[d])[:pool]

        if self.use_rerank:
            candidates = [(doc_id, self._docs[doc_id]) for doc_id in ranked]
            reranked = lexical_rerank(query, candidates, top_k)
            return [
                {"id": doc_id, "score": score, "text": self._docs[doc_id], "method": "hybrid+rerank"}
                for doc_id, score in reranked
            ]
        return [
            {"id": doc_id, "score": fused[doc_id], "text": self._docs[doc_id], "method": "hybrid"}
            for doc_id in ranked[:top_k]
        ]

    def search_dual(self, bm25_query: str, embed_query: str, top_k: int = 5, pool: int = 20) -> list[dict]:
        """稀疏(BM25)与稠密(向量)用不同文本检索 —— 支持 HyDE（用"假设文档"做向量召回）。"""
        bm25_ids = self._bm25_rank(bm25_query, pool)
        vec_ids = self._vector_rank(embed_query, pool)
        fused = reciprocal_rank_fusion([bm25_ids, vec_ids])
        ranked = sorted(fused, key=lambda d: -fused[d])[:top_k]
        return [{"id": d, "score": fused[d], "text": self._docs[d], "method": "hyde"} for d in ranked]

    def search_multi(self, queries: list[str], top_k: int = 5, pool: int = 20) -> list[dict]:
        """多查询检索：每个查询各跑 BM25+向量，全部排名 RRF 融合（多查询扩展）。"""
        rankings: list[list[str]] = []
        for q in queries:
            rankings.append(self._bm25_rank(q, pool))
            rankings.append(self._vector_rank(q, pool))
        fused = reciprocal_rank_fusion(rankings)
        ranked = sorted(fused, key=lambda d: -fused[d])[:top_k]
        return [{"id": d, "score": fused[d], "text": self._docs[d], "method": "multi_query"} for d in ranked]
