"""Agentic RAG 验收测试（离线）。

覆盖：检索工具执行器(含 CRAG 自评提示) / 检索作为工具的 agentic 循环 /
多跳改写检索 / 模型自主不检索 / 答案溯源引用。
用 ScriptedAdapter 注入受控模型响应。
"""

from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.retrieval import AgenticRAG, HashingEmbedding, RAGPipeline, get_reranker


def _kb():
    rag = RAGPipeline(embedder=HashingEmbedding(), reranker=get_reranker("lexical"))
    rag.ingest_text(
        "用户最喜欢的编程语言是 Python，主要用于后端开发。\n\n"
        "用户的项目部署在 AWS 云服务器上。\n\n"
        "用户每天早上九点开始工作。",
        source="profile.md",
        max_tokens=40,
    )
    return rag


class _ScriptedAdapter:
    model_name = "deepseek-chat"

    def __init__(self, script):
        self.script = script
        self.idx = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kwargs):
        resp = self.script[min(self.idx, len(self.script) - 1)]
        self.idx += 1
        return resp


def _search(call_id, query):
    return ToolCallResponse(
        content="",
        finish_reason="tool_calls",
        tool_calls=[ToolCall(call_id, "knowledge_search", '{"query":"%s"}' % query)],
    )


def _final(text):
    return ToolCallResponse(content=text, finish_reason="stop", tool_calls=[])


def test_executor_returns_chunks_and_crag_note():
    rag = AgenticRAG(_kb(), adapter=None, min_relevance=999.0)  # 强制触发低相关度自评
    res = rag._executor("knowledge_search", {"query": "Python 后端", "top_k": 2})
    assert res.success
    assert "[" in res.output  # 含 chunk id 标记
    assert "自评" in res.output  # CRAG 提示
    assert rag._retrievals[0]["query"] == "Python 后端"


def test_executor_unknown_tool():
    res = AgenticRAG(_kb(), adapter=None)._executor("other_tool", {})
    assert not res.success


def test_agentic_rag_retrieval_as_tool_with_citations():
    adapter = _ScriptedAdapter([
        _search("c1", "Python 后端 编程语言"),
        _final("用户用 Python 做后端开发。"),
    ])
    rag = AgenticRAG(_kb(), adapter)
    result = rag.run("用户用什么编程语言做后端？", max_steps=5)

    assert "Python" in result.answer
    assert result.citations, "应有溯源引用"
    assert all(c.source == "profile.md" for c in result.citations)
    assert len(result.retrievals) == 1  # 检索了一次
    assert result.observability is not None  # 复用可观测层
    assert result.steps >= 2


def test_agentic_rag_multi_hop_reformulation():
    adapter = _ScriptedAdapter([
        _search("c1", "部署"),
        _search("c2", "AWS 云服务器 部署位置"),  # 改写后再检索(多跳)
        _final("项目部署在 AWS。"),
    ])
    rag = AgenticRAG(_kb(), adapter)
    result = rag.run("项目部署在哪里？", max_steps=5)
    assert len(result.retrievals) == 2  # 多跳检索
    assert "AWS" in result.answer


def test_agentic_rag_no_retrieval_when_unnecessary():
    adapter = _ScriptedAdapter([_final("你好！很高兴见到你。")])
    rag = AgenticRAG(_kb(), adapter)
    result = rag.run("打个招呼", max_steps=5)
    assert result.answer == "你好！很高兴见到你。"
    assert result.retrievals == []  # 未检索
    assert result.citations == []
