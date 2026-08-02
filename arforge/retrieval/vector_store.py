"""向量库 — numpy 余弦检索，可持久化（P1-5）。

默认 numpy 暴力余弦（对代码库规模完全够用，零额外依赖）；预留 FAISS 后端可后插。
向量假定已 L2 归一化，故余弦相似度 = 点积。
"""

from __future__ import annotations

import json
import os

import numpy as np


class VectorStore:
    """内存向量库 + 磁盘持久化。"""

    def __init__(self, dim: int):
        self.dim = dim
        self._ids: list[str] = []
        self._matrix: np.ndarray = np.zeros((0, dim), dtype=np.float32)

    def __len__(self) -> int:
        return len(self._ids)

    def add(self, ids: list[str], vectors: np.ndarray) -> None:
        if vectors.shape[0] != len(ids):
            raise ValueError("ids 与 vectors 数量不一致")
        if vectors.shape[0] == 0:
            return
        if vectors.shape[1] != self.dim:
            raise ValueError(f"向量维度 {vectors.shape[1]} != store 维度 {self.dim}")
        vectors = vectors.astype(np.float32)
        self._ids.extend(ids)
        self._matrix = vectors if len(self._matrix) == 0 else np.vstack([self._matrix, vectors])

    def search(self, query: np.ndarray, k: int = 10) -> list[tuple[str, float]]:
        if len(self._ids) == 0:
            return []
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        scores = self._matrix @ q  # 已归一化 → 点积即余弦
        k = min(k, len(self._ids))
        # argpartition 取 top-k，再对这 k 个排序（比全排序快）
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top])]
        return [(self._ids[i], float(scores[i])) for i in top]

    def save(self, path: str) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        np.save(path + ".npy", self._matrix)
        with open(path + ".ids.json", "w", encoding="utf-8") as f:
            json.dump({"dim": self.dim, "ids": self._ids}, f, ensure_ascii=False)

    @classmethod
    def load(cls, path: str) -> "VectorStore":
        with open(path + ".ids.json", encoding="utf-8") as f:
            meta = json.load(f)
        store = cls(meta["dim"])
        store._ids = meta["ids"]
        store._matrix = np.load(path + ".npy").astype(np.float32)
        return store


class FaissVectorStore:
    """FAISS 后端向量库（faiss 安装后启用），接口与 VectorStore 一致。

    用 IndexFlatIP（内积），向量已 L2 归一化故等价余弦。生产可换 HNSW/IVF 索引。
    """

    def __init__(self, dim: int):
        import faiss  # 仅在选用 FAISS 时依赖

        self.dim = dim
        self._faiss = faiss
        self._index = faiss.IndexFlatIP(dim)
        self._ids: list[str] = []

    def __len__(self) -> int:
        return len(self._ids)

    def add(self, ids: list[str], vectors: np.ndarray) -> None:
        if len(ids) == 0:
            return
        self._index.add(vectors.astype(np.float32))
        self._ids.extend(ids)

    def search(self, query: np.ndarray, k: int = 10) -> list[tuple[str, float]]:
        if not self._ids:
            return []
        q = np.asarray(query, dtype=np.float32).reshape(1, -1)
        k = min(k, len(self._ids))
        scores, idx = self._index.search(q, k)
        return [(self._ids[i], float(s)) for s, i in zip(scores[0], idx[0]) if i >= 0]


def get_vector_store(dim: int, backend: str = "auto"):
    """工厂：backend='faiss' 强制 FAISS；'auto' 优先 FAISS、不可用回退 numpy；'numpy' 强制 numpy。

    Milvus/Qdrant/pgvector 等服务型向量库可在此扩展同样接口的后端。
    """
    if backend in ("faiss", "auto"):
        try:
            return FaissVectorStore(dim)
        except Exception:
            if backend == "faiss":
                raise
    return VectorStore(dim)
