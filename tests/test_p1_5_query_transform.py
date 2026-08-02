"""查询变换验收测试（离线，fake adapter）。

覆盖：HyDE / 多查询(解析+去编号) / 改写 / 分解(JSON) / 异常回退。
"""

from arforge.retrieval import HashingEmbedding, RAGPipeline, get_reranker
from arforge.retrieval.query_transform import decompose, hyde, multi_query, rewrite


class _Fake:
    def __init__(self, out):
        self.out = out
        self.calls = []

    def generate(self, messages, **kwargs):
        self.calls.append(messages)
        return self.out


class _Boom:
    def generate(self, messages, **kwargs):
        raise RuntimeError("provider down")


def test_hyde_returns_hypothetical_doc():
    out = hyde("如何部署?", _Fake("部署步骤：先构建镜像，再用 docker compose 启动服务。"))
    assert "docker" in out


def test_hyde_fallback_on_error():
    assert hyde("原始问题", _Boom()) == "原始问题"


def test_multi_query_parses_and_strips_numbering():
    fake = _Fake("1. 怎么部署项目\n2) 项目上线流程\n- 部署到生产环境")
    variants = multi_query("如何部署?", fake, n=3)
    assert len(variants) == 3
    assert all(not v[0].isdigit() and not v.startswith("-") for v in variants)
    assert "怎么部署项目" in variants


def test_multi_query_empty_on_error():
    assert multi_query("x", _Boom()) == []


def test_rewrite():
    assert rewrite("它怎么装?", _Fake("Arforge 的安装方法"), history="在聊 Arforge") == "Arforge 的安装方法"
    assert rewrite("原问题", _Boom()) == "原问题"


def test_decompose_json():
    fake = _Fake('{"subquestions": ["A 是什么", "B 怎么用"]}')
    subs = decompose("A 和 B 的关系及用法?", fake)
    assert subs == ["A 是什么", "B 怎么用"]


def test_decompose_fallback_on_garbage():
    assert decompose("问题", _Fake("不是 JSON 的文本")) == ["问题"]


# --------------------------- 集成到 RAGPipeline.retrieve ---------------------------


def _kb():
    rag = RAGPipeline(embedder=HashingEmbedding(), reranker=get_reranker("lexical"))
    rag.ingest_text(
        "用户最喜欢的编程语言是 Python，主要用于后端开发。\n\n"
        "用户的项目部署在 AWS 云服务器上。\n\n"
        "用户每天早上九点开始工作。",
        source="p.md",
        max_tokens=25,
    )
    return rag


class _HydeFake:
    def generate(self, messages, **kwargs):
        return "用户用 Python 编程语言进行后端开发的相关说明"  # 假设文档含目标关键词


class _MultiFake:
    def generate(self, messages, **kwargs):
        return "Python 后端\n编程语言 后端开发\n用什么语言写后端"


def test_retrieve_hyde_transform():
    hits = _kb().retrieve("后端用啥写的", top_k=2, adapter=_HydeFake(), transform="hyde")
    assert any("Python" in h["text"] for h in hits)


def test_retrieve_multi_transform():
    hits = _kb().retrieve("后端语言", top_k=2, adapter=_MultiFake(), transform="multi")
    assert any("Python" in h["text"] for h in hits)


def test_retrieve_none_transform_needs_no_adapter():
    hits = _kb().retrieve("Python 后端开发", top_k=1)  # 默认 none，无需 adapter
    assert hits and "Python" in hits[0]["text"]
