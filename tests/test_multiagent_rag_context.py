"""P1-3 RAG/记忆接入规划阶段 验收测试。

覆盖：_recall_context 检索记忆 / ARFORGE_DISABLE_RAG 开关跳过 /
_build_prompt 注入共享上下文 / 无上下文不退化 / _multi_agent_path 写入 shared_memory["context"]。
"""

from types import SimpleNamespace

from arforge.memory_vector import VectorMemory
from arforge.multiagent.agents import CoderAgent
from arforge.multiagent.master_agent import MasterAgent, QualityAssessment, TaskUnderstanding
from arforge.multiagent.protocol import Conversation, Task, TaskResult
from arforge.retrieval import HashingEmbedding


def _vm():
    vm = VectorMemory(embedder=HashingEmbedding())
    vm.add("1", "用户偏好用 Python 做后端开发")
    vm.add("2", "项目部署在 AWS 云服务器")
    return vm


def test_recall_context_returns_relevant_memory():
    m = MasterAgent(None)
    m._vector_memory = _vm()  # 直接注入，避免 DB 依赖
    ctx = m._recall_context("Python 后端", top_k=1)
    assert "Python" in ctx


def test_recall_context_disabled_switch(monkeypatch):
    monkeypatch.setenv("ARFORGE_DISABLE_RAG", "1")
    m = MasterAgent(None)
    m._vector_memory = _vm()
    assert m._recall_context("Python 后端") == ""  # 开关关闭→跳过


def test_recall_context_no_data_no_crash():
    m = MasterAgent(None)
    m._vector_memory = VectorMemory(embedder=HashingEmbedding())  # 空记忆
    assert m._recall_context("任何问题") == ""  # 不退化、不报错


def test_build_prompt_injects_shared_context():
    conv = Conversation(master_goal="g")
    conv.shared_memory["context"] = "用户偏好 Python 后端开发"
    messages = CoderAgent()._build_prompt(Task(task_id="t", goal="实现功能"), conv)
    system = messages[0]["content"]
    assert "用户偏好 Python 后端开发" in system
    assert "Reference (from project memory/knowledge" in system


def test_build_prompt_without_context_not_degraded():
    conv = Conversation(master_goal="g")  # 无 context
    messages = CoderAgent()._build_prompt(Task(task_id="t", goal="实现功能"), conv)
    assert len(messages) == 3  # system + user + coding instruction (agentic-first) 正常
    assert "Reference (from project memory/knowledge" not in messages[0]["content"]


def test_multi_agent_path_stores_context_into_shared_memory():
    m = MasterAgent(None)
    m._recall_context = lambda user_input, top_k=5: "检索到的项目上下文"
    captured = {}
    m._decompose = lambda ui, u: [Task(task_id="s1", role="CoderAgent", goal="g")]

    def _fake_dispatch(tasks, conv):
        captured["ctx"] = conv.shared_memory.get("context")
        return [TaskResult(task_id="s1", role="CoderAgent", success=True, output="done")]

    m._dispatcher = SimpleNamespace(dispatch=_fake_dispatch)
    m._evaluate = lambda conv, ui: QualityAssessment(satisfied=True, score=1.0)
    m._merger = SimpleNamespace(merge=lambda conv, ui: {"answer": "x"})

    u = TaskUnderstanding(intent="x", complexity="simple", suggested_roles=[], estimated_steps=1, needs_multiagent=True)
    m._multi_agent_path("做点事", u)

    assert captured["ctx"] == "检索到的项目上下文"  # 检索结果进入共享上下文，dispatch 时可见
