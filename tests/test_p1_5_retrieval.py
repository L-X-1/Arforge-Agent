"""P1-5 向量 RAG 验收测试（离线可跑）。

覆盖：HashingEmbedding 确定性/归一化/相对相似度 / VectorStore 检索+持久化 /
RRF 融合 / lexical rerank / HybridRetriever 端到端 / 工厂回退 /
（可选）LocalEmbedding 真语义（模型不可用时 skip，不伪造通过）。
"""

import numpy as np
import pytest

from arforge.retrieval import (
    HashingEmbedding,
    HybridRetriever,
    VectorStore,
    get_embedding_provider,
    lexical_rerank,
    reciprocal_rank_fusion,
)


def test_hashing_embedding_deterministic_and_normalized():
    emb = HashingEmbedding(dim=256)
    v1 = emb.embed(["read a file"])
    v2 = emb.embed(["read a file"])
    assert v1.shape == (1, 256)
    assert np.allclose(v1, v2)  # 确定性
    assert abs(float((v1[0] ** 2).sum()) - 1.0) < 1e-5  # L2 归一化


def test_hashing_embedding_relative_similarity():
    emb = HashingEmbedding()
    v = emb.embed(["read a file from disk", "read file content", "delete the database"])
    sim_related = float(v[0] @ v[1])
    sim_unrelated = float(v[0] @ v[2])
    assert sim_related > sim_unrelated


def test_hashing_embedding_empty():
    emb = HashingEmbedding(dim=128)
    assert emb.embed([]).shape == (0, 128)


def test_vector_store_search_nearest():
    store = VectorStore(dim=3)
    store.add(["a", "b", "c"], np.array([[1, 0, 0], [0, 1, 0], [0.9, 0.1, 0]], dtype=np.float32))
    hits = store.search(np.array([1, 0, 0], dtype=np.float32), k=2)
    assert hits[0][0] == "a"
    assert hits[1][0] == "c"  # 与 a 最接近
    assert len(store) == 3


def test_vector_store_dim_mismatch_raises():
    store = VectorStore(dim=4)
    with pytest.raises(ValueError):
        store.add(["x"], np.zeros((1, 3), dtype=np.float32))


def test_vector_store_persistence(tmp_path):
    store = VectorStore(dim=3)
    store.add(["a", "b"], np.array([[1, 0, 0], [0, 1, 0]], dtype=np.float32))
    path = str(tmp_path / "idx")
    store.save(path)
    loaded = VectorStore.load(path)
    assert len(loaded) == 2
    assert loaded.search(np.array([0, 1, 0], dtype=np.float32), k=1)[0][0] == "b"


def test_reciprocal_rank_fusion_order():
    # d1 在两路都靠前 → 融合分最高
    fused = reciprocal_rank_fusion([["d1", "d2", "d3"], ["d1", "d3", "d2"]])
    assert max(fused, key=lambda d: fused[d]) == "d1"
    assert fused["d1"] > fused["d2"]


def test_lexical_rerank_boosts_query_terms():
    cands = [
        ("d1", "completely unrelated content about weather"),
        ("d2", "function to read file from disk path"),
    ]
    ranked = lexical_rerank("read file path", cands, top_n=2)
    assert ranked[0][0] == "d2"


def test_hybrid_retriever_end_to_end():
    retriever = HybridRetriever(embedder=HashingEmbedding())
    docs = [
        ("d1", "def read_file(path): return open(path).read()  # 读取文件内容"),
        ("d2", "def delete_table(name): db.drop(name)  # 删除数据库表"),
        ("d3", "def write_file(path, data): open(path, 'w').write(data)"),
    ]
    retriever.index(docs)
    hits = retriever.search("load file contents from disk", top_k=2)
    ids = [h["id"] for h in hits]
    assert "d1" in ids  # 文件读取最相关
    assert "d2" not in ids[:1]  # 删除表不应排第一


def test_hybrid_retriever_bm25_keyword_path():
    retriever = HybridRetriever(embedder=HashingEmbedding(), use_rerank=False)
    retriever.index([("d1", "alpha beta"), ("d2", "gamma delta epsilon")])
    hits = retriever.search("gamma", top_k=1)
    assert hits[0]["id"] == "d2"


def test_hybrid_retriever_empty_corpus():
    retriever = HybridRetriever(embedder=HashingEmbedding())
    retriever.index([])
    assert retriever.search("anything") == []


def test_get_embedding_provider_factory():
    assert isinstance(get_embedding_provider("hashing"), HashingEmbedding)
    # 未知后端 → 回退 hashing（不抛异常）
    assert isinstance(get_embedding_provider("nonexistent-backend"), HashingEmbedding)


def test_local_embedding_true_semantic_optional():
    """真语义测试：词面无重叠但语义相近。模型不可用(离线/未下载)时 skip。"""
    pytest.importorskip("sentence_transformers")
    try:
        from arforge.retrieval.embedding import LocalEmbedding

        emb = LocalEmbedding("all-MiniLM-L6-v2")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"本地 embedding 模型不可用: {exc}")
    v = emb.embed(["the cat sat on the mat", "a feline rested on a rug", "stock market crashed"])
    sim_related = float(v[0] @ v[1])
    sim_unrelated = float(v[0] @ v[2])
    assert sim_related > sim_unrelated  # 仅真实语义模型能通过(无词面重叠)
