"""Agentic RAG — 检索作为 Agent 工具（Self-RAG / CRAG 风格）。

相比经典 RAG（固定"检索一次→拼接→生成"），Agentic RAG 让模型自主决定：
- 是否需要检索；
- 用什么 query 检索（可改写/细化，多跳）；
- 检索结果不相关/不足时再次检索（CRAG 自评 → 重检）；
- 拿到足够资料后只依据资料作答，并 [chunk_id] 标注来源。

实现：把"知识库检索"做成一个工具，交给 core.agentic.run_tool_loop（与单/多 Agent 同一循环）；
引用 = 循环中实际检索到的 chunk；全程复用可观测层。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from arforge.core.agentic import run_tool_loop
from arforge.retrieval.pipeline import Citation, RAGPipeline
from arforge.tool_registry import ToolResult

_RAG_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "knowledge_search",
        "description": "在知识库中检索与查询最相关的资料片段。需要事实/文档依据时调用；可用不同措辞多次检索。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索查询（可改写、细化）"},
                "top_k": {"type": "integer", "description": "返回片段数，默认 5"},
            },
            "required": ["query"],
        },
    },
}

_SYSTEM_PROMPT = (
    "你是基于知识库的 Agentic RAG 助手。回答前先用 knowledge_search 检索资料；"
    "若结果不相关或不足，改写查询再次检索（最多数次）；拿到足够资料后，只依据资料回答，"
    "并在每条事实后用 [chunk_id] 标注来源；资料不足就明确说不知道，绝不编造。"
)


@dataclass
class AgenticRAGResult:
    answer: str
    citations: list = field(default_factory=list)
    retrievals: list = field(default_factory=list)  # 每轮检索的 query + 命中 + 最佳相关度
    observability: dict | None = None
    steps: int = 0


class AgenticRAG:
    """检索作为工具的 agentic RAG。pipeline 提供知识库，adapter 提供 LLM。"""

    def __init__(self, pipeline: RAGPipeline, adapter, min_relevance: float = 0.15):
        self.pipeline = pipeline
        self.adapter = adapter
        self.min_relevance = min_relevance
        self._retrieved: dict = {}
        self._retrievals: list = []

    def _executor(self, name: str, args: dict) -> ToolResult:
        """工具执行器：knowledge_search → 知识库检索（带 CRAG 自评提示）。"""
        if name != "knowledge_search":
            return ToolResult(name, False, "", f"unknown tool: {name}")
        query = str(args.get("query", "")).strip()
        try:
            top_k = int(args.get("top_k", 5) or 5)
        except (TypeError, ValueError):
            top_k = 5
        if not query:
            return ToolResult(name, False, "", "query 不能为空")

        hits = self.pipeline.retrieve(query, top_k=top_k)
        best = hits[0]["score"] if hits else 0.0
        for h in hits:
            self._retrieved[h["id"]] = h
        self._retrievals.append({"query": query, "hits": [h["id"] for h in hits], "best_score": round(float(best), 4)})

        if not hits:
            return ToolResult(name, True, "未检索到相关资料。建议改写查询或更换关键词后重试。")
        lines = [f"[{h['id']}] (来源:{h['source']}, 相关度:{round(float(h['score']), 3)})\n{h['text']}" for h in hits]
        # CRAG 自评：相关度偏低时提示模型改写重检
        note = "" if best >= self.min_relevance else "\n\n[自评] 最佳相关度较低，建议改写查询后再次检索。"
        return ToolResult(name, True, "\n\n".join(lines) + note)

    def run(self, question: str, max_steps: int = 6) -> AgenticRAGResult:
        self._retrieved = {}
        self._retrievals = []
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": question},
        ]
        result = run_tool_loop(
            self.adapter,
            messages,
            tools=[_RAG_TOOL_SCHEMA],
            max_steps=max_steps,
            span_name="agentic_rag",
            executor=self._executor,
        )
        citations = [
            Citation(id=h["id"], source=h["source"], snippet=h["text"][:160], score=round(float(h["score"]), 4))
            for h in self._retrieved.values()
        ]
        return AgenticRAGResult(
            answer=result.answer,
            citations=citations,
            retrievals=self._retrievals,
            observability=result.observability,
            steps=result.steps,
        )
