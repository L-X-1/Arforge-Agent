"""重排序 — cross-encoder（真精排）+ lexical（离线兜底）。

cross-encoder 用 sentence-transformers CrossEncoder（如 ms-marco-MiniLM / bge-reranker），
对 (query, doc) 对直接打相关性分，精度远高于双塔召回；模型不可用（离线/未下载）时
自动回退 lexical。通过 get_reranker(backend) 选择。
"""

from __future__ import annotations

from arforge.retrieval.hybrid import lexical_rerank


class Reranker:
    """重排接口：rerank(query, candidates=[(id, text)], top_n) -> [(id, score)]。"""

    def rerank(self, query: str, candidates: list, top_n: int) -> list:
        raise NotImplementedError


class LexicalReranker(Reranker):
    """离线 lexical 重排（查询词覆盖度），零依赖、确定性。"""

    def rerank(self, query: str, candidates: list, top_n: int) -> list:
        return lexical_rerank(query, candidates, top_n)


class CrossEncoderReranker(Reranker):
    """sentence-transformers CrossEncoder 真重排。"""

    def __init__(self, model_name: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"):
        from sentence_transformers import CrossEncoder

        self._model = CrossEncoder(model_name)

    def rerank(self, query: str, candidates: list, top_n: int) -> list:
        if not candidates:
            return []
        scores = self._model.predict([[query, text] for _id, text in candidates])
        ranked = sorted(zip(candidates, scores), key=lambda x: -float(x[1]))
        return [(cid, float(score)) for (cid, _text), score in ranked[:top_n]]


def get_reranker(backend: str = "lexical", **kwargs) -> Reranker:
    """工厂：'cross_encoder' 失败（离线/无模型）自动回退 'lexical'。"""
    if backend in ("cross_encoder", "cross-encoder", "ce"):
        try:
            return CrossEncoderReranker(**kwargs)
        except Exception:
            return LexicalReranker()
    return LexicalReranker()
