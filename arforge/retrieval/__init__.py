"""检索层 — 企业级 RAG（P1-5 检索核心 + 完整摄入/生成管线）。

摄入：loaders(解析) → clean(清洗去重) → chunking(智能分块+Contextual)。
索引：embedding(三后端) → vector_store(numpy/FAISS) + BM25。
检索：hybrid(BM25+向量 RRF) → reranker(cross-encoder/lexical)。
生成：pipeline.RAGPipeline.answer 产出带溯源引用(Citation)的 grounded 答案。
TF-IDF(semantic_code_search) 作为离线 fallback 保留。
"""

from arforge.retrieval.chunking import Chunk, chunk_text, contextualize, estimate_tokens
from arforge.retrieval.clean import dedup_chunks, normalize_text
from arforge.retrieval.embedding import (
    APIEmbedding,
    EmbeddingProvider,
    HashingEmbedding,
    LocalEmbedding,
    get_embedding_provider,
)
from arforge.retrieval.hybrid import (
    HybridRetriever,
    lexical_rerank,
    reciprocal_rank_fusion,
    tokenize,
)
from arforge.retrieval.loaders import (
    RawDoc,
    load_directory,
    load_document,
    load_documents,
    load_text,
)
from arforge.retrieval.agentic_rag import AgenticRAG, AgenticRAGResult
from arforge.retrieval.pipeline import Citation, RAGAnswer, RAGPipeline
from arforge.retrieval.query_transform import decompose, hyde, multi_query, rewrite
from arforge.retrieval.reranker import (
    CrossEncoderReranker,
    LexicalReranker,
    Reranker,
    get_reranker,
)
from arforge.retrieval.vector_store import FaissVectorStore, VectorStore, get_vector_store

__all__ = [
    # embedding
    "APIEmbedding", "EmbeddingProvider", "HashingEmbedding", "LocalEmbedding", "get_embedding_provider",
    # vector store
    "VectorStore", "FaissVectorStore", "get_vector_store",
    # hybrid retrieval
    "HybridRetriever", "lexical_rerank", "reciprocal_rank_fusion", "tokenize",
    # ingestion
    "RawDoc", "load_document", "load_documents", "load_directory", "load_text",
    "normalize_text", "dedup_chunks",
    "Chunk", "chunk_text", "contextualize", "estimate_tokens",
    # rerank
    "Reranker", "LexicalReranker", "CrossEncoderReranker", "get_reranker",
    # pipeline + agentic RAG
    "RAGPipeline", "RAGAnswer", "Citation", "AgenticRAG", "AgenticRAGResult",
    # query transformation
    "hyde", "multi_query", "rewrite", "decompose",
]
