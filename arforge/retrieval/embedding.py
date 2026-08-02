"""Embedding 提供方抽象 + 三后端（P1-5）。

后端可切换（环境变量 ARFORGE_EMBED_BACKEND = api | local | hashing）：
- api    : OpenAI/DeepSeek 兼容 embedding API（联网、语义最强）
- local  : sentence-transformers 本地模型（离线、中文友好；首次需下载模型）
- hashing: pure-numpy deterministic hashing 特征哈希（纯离线、确定性、零下载；作默认兜底，保证任何环境可用）

所有后端统一返回 L2 归一化的 numpy 向量，使余弦相似度 = 点积。
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod

import numpy as np


def _l2_normalize(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


class EmbeddingProvider(ABC):
    """统一 embedding 接口。子类需设置 self.dim 并实现 embed()。"""

    dim: int = 0

    @abstractmethod
    def embed(self, texts: list[str]) -> np.ndarray:
        """返回 shape=(len(texts), dim) 的 L2 归一化 float32 向量。"""

    def embed_one(self, text: str) -> np.ndarray:
        return self.embed([text])[0]


class HashingEmbedding(EmbeddingProvider):
    """Pure-numpy deterministic hashing embedding (chinese-friendly char n-grams).

    Uses character n-gram hashing via Python built-in hash with a fixed seed
    for cross-run determinism. Zero external dependencies beyond numpy.

    Character-wb n-grams (3-5) capture subword patterns well for CJK text
    while remaining lightweight for Latin scripts.
    """

    def __init__(self, dim: int = 512):
        self.dim = dim
        import hashlib
        self._seed = int(hashlib.md5(b"arforge_hash_emb_v2").hexdigest()[:8], 16)

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        mat = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            row = mat[i]
            t = " " + text + " "
            n = len(t)
            for ng in (3, 4, 5):
                for j in range(max(0, n - ng + 1)):
                    gram = t[j:j + ng]
                    h = hash((self._seed, ng, gram)) & 0x7FFFFFFF
                    idx = h % self.dim
                    row[idx] += 1.0
        return _l2_normalize(mat)

class LocalEmbedding(EmbeddingProvider):
    """sentence-transformers 本地模型 embedding（真实语义，离线运行）。"""

    def __init__(self, model_name: str = "all-MiniLM-L6-v2"):
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(model_name)
        self.dim = int(self._model.get_sentence_embedding_dimension())

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        vecs = self._model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
        return vecs.astype(np.float32)


class APIEmbedding(EmbeddingProvider):
    """OpenAI/DeepSeek 兼容 embedding API（按量计费、语义强）。"""

    def __init__(self, model: str | None = None, api_key: str | None = None, base_url: str | None = None):
        import config
        from openai import OpenAI

        self.model = model or getattr(config, "EMBED_MODEL", "text-embedding-3-small")
        key = api_key or getattr(config, "EMBED_API_KEY", "") or getattr(config, "DEEPSEEK_API_KEY", "")
        url = base_url or getattr(config, "EMBED_BASE_URL", None)
        self._client = OpenAI(api_key=key, base_url=url) if url else OpenAI(api_key=key)
        self.dim = 0  # 首次调用后按返回维度确定

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim or 1), dtype=np.float32)
        resp = self._client.embeddings.create(model=self.model, input=texts)
        mat = np.array([d.embedding for d in resp.data], dtype=np.float32)
        self.dim = mat.shape[1]
        return _l2_normalize(mat)


def get_embedding_provider(backend: str | None = None, **kwargs) -> EmbeddingProvider:
    """工厂：按 backend 或 ARFORGE_EMBED_BACKEND 构建；任何后端构建失败回退 hashing。"""
    backend = (backend or os.environ.get("ARFORGE_EMBED_BACKEND", "hashing")).lower()
    try:
        if backend == "api":
            return APIEmbedding(**kwargs)
        if backend == "local":
            return LocalEmbedding(**kwargs)
        if backend == "hashing":
            return HashingEmbedding(**kwargs)
    except Exception:
        pass
    return HashingEmbedding()
