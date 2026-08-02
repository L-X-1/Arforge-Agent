"""企业级 RAG 管线验收测试（离线）。

覆盖：清洗(normalize/dedup) / 智能分块(结构+token+overlap+contextual) / 文档解析 /
重排工厂 / 向量库工厂 / 端到端 ingest→retrieve→带溯源引用的 answer。
"""

import json

from arforge.retrieval import (
    Chunk,
    HashingEmbedding,
    RAGPipeline,
    VectorStore,
    chunk_text,
    contextualize,
    dedup_chunks,
    estimate_tokens,
    get_reranker,
    get_vector_store,
    load_document,
    load_text,
    normalize_text,
)
from arforge.retrieval.reranker import LexicalReranker


# ---------------------------- 清洗 ----------------------------


def test_normalize_text_strips_control_and_blanklines():
    raw = "标题\r\n\n\n\n正文​有零宽\x07字符\n\n\n结尾   "
    out = normalize_text(raw)
    assert "\x07" not in out
    assert "​" not in out  # 零宽
    assert "\n\n\n" not in out  # 折叠空行
    assert out.startswith("标题")


def test_dedup_chunks():
    chunks = [Chunk("a", "重复内容 X"), Chunk("b", "重复内容  x"), Chunk("c", "不同内容 Y")]
    out = dedup_chunks(chunks)
    assert len(out) == 2  # b 与 a 规范化后重复


# ---------------------------- 分块 ----------------------------


def test_estimate_tokens():
    assert estimate_tokens("") == 0
    assert estimate_tokens("中文字符") == 4  # CJK ~1 token/字
    assert estimate_tokens("abcdefgh") == 2  # 非 CJK ~1 token/4 字符


def test_chunk_text_splits_and_preserves_content():
    text = "\n\n".join([f"第{i}段：" + "内容数据" * 30 for i in range(6)])
    chunks = chunk_text(text, source="doc1", max_tokens=120, overlap_tokens=20)
    assert len(chunks) >= 2
    assert all(c.source == "doc1" for c in chunks)
    # 内容覆盖：每段的关键标记都应出现在某个块里
    joined = "\n".join(c.text for c in chunks)
    for i in range(6):
        assert f"第{i}段" in joined


def test_chunk_text_long_single_segment():
    text = "句子。" * 500  # 单个超长段
    chunks = chunk_text(text, source="d", max_tokens=100)
    assert len(chunks) >= 2  # 超长段被按句切分


def test_contextualize_adds_prefix():
    chunks = chunk_text("一些内容数据" * 20, source="手册.md", max_tokens=80)
    contextualize(chunks, doc_title="手册.md")
    assert chunks[0].embed_text().startswith("[来源:手册.md")
    assert chunks[0].text in chunks[0].embed_text()  # 原文保留


# ---------------------------- 解析 ----------------------------


def test_load_text():
    doc = load_text("hello world", source="x")
    assert doc.text == "hello world"
    assert doc.doctype == "text"


def test_load_document_json_and_csv(tmp_path):
    jp = tmp_path / "d.json"
    jp.write_text(json.dumps({"k": "v", "n": 1}), encoding="utf-8")
    doc = load_document(str(jp))
    assert doc.doctype == "json"
    assert '"k"' in doc.text

    cp = tmp_path / "d.csv"
    cp.write_text("a,b\n1,2\n", encoding="utf-8")
    csv_doc = load_document(str(cp))
    assert csv_doc.doctype == "csv"
    assert "a | b" in csv_doc.text


# ---------------------------- 工厂 ----------------------------


def test_reranker_factory():
    assert isinstance(get_reranker("lexical"), LexicalReranker)
    # cross_encoder 不可用时回退 lexical（不抛异常）
    assert get_reranker("cross_encoder") is not None


def test_vector_store_factory_numpy():
    store = get_vector_store(8, backend="numpy")
    assert isinstance(store, VectorStore)
    # auto: faiss 缺失 → 回退 numpy
    assert get_vector_store(8, backend="auto") is not None


# ---------------------------- 端到端管线 ----------------------------


class _FakeLLM:
    def __init__(self):
        self.last_prompt = None

    def generate(self, messages, **kwargs):
        self.last_prompt = messages[0]["content"]
        return "根据资料，用户用 Python 做后端开发。"


def _pipeline():
    return RAGPipeline(embedder=HashingEmbedding(), reranker=get_reranker("lexical"))


def test_rag_pipeline_end_to_end_with_citations():
    rag = _pipeline()
    n = rag.ingest_text(
        "用户最喜欢的编程语言是 Python，主要用于后端开发。\n\n"
        "用户的项目部署在 AWS 云服务器上。\n\n"
        "用户每天早上九点开始工作。",
        source="profile.md",
        max_tokens=40,
    )
    assert n >= 2  # 切成多块

    llm = _FakeLLM()
    result = rag.answer("用户用什么编程语言做后端", llm, top_k=2)

    # 1) 返回了带溯源的引用
    assert result.citations, "应返回引用"
    assert all(c.source == "profile.md" for c in result.citations)
    # 2) 检索到的最相关上下文包含 Python
    assert any("Python" in c["text"] for c in result.contexts)
    # 3) grounded prompt 强制 [id] 引用 + 含检索到的资料
    assert "[id]" in llm.last_prompt
    assert "Python" in llm.last_prompt
    # 4) 生成了答案
    assert "Python" in result.answer


def test_rag_pipeline_empty_knowledge_base():
    rag = _pipeline()
    result = rag.answer("任何问题", _FakeLLM())
    assert "没有相关信息" in result.answer
    assert result.citations == []
