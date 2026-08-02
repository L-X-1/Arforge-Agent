"""P0-2 master_agent 改用 structured 层 验收测试。

覆盖：散文包裹 JSON 仍解析成功(extract_json 兜底) / 三阶段 JSON 统计 /
adapter 异常走 heuristic(双路径降级) / observability.json_parse 透出。
"""

from types import SimpleNamespace

from arforge.multiagent.master_agent import MasterAgent, QualityAssessment, TaskUnderstanding
from arforge.multiagent.protocol import Conversation, Task, TaskResult


class _ProseAdapter:
    """返回散文包裹的 JSON（旧 find/rfind 易失败，验证 extract_json 兜底）。"""

    def __init__(self, payload):
        self.payload = payload

    def generate(self, messages, max_tokens=None, temperature=None, response_format=None, **kwargs):
        return f"好的，分析如下：\n{self.payload}\n（以上）"


class _BoomAdapter:
    def generate(self, messages, **kwargs):
        raise RuntimeError("network down")


def _master(adapter):
    return MasterAgent(SimpleNamespace(adapter=adapter))


def test_understand_parses_prose_wrapped_json():
    payload = (
        '{"intent":"加功能","complexity":"medium","suggested_roles":["CoderAgent"],'
        '"estimated_steps":3,"needs_multiagent":true}'
    )
    m = _master(_ProseAdapter(payload))
    u = m._understand_via_model("给项目加个功能")
    assert u.intent == "加功能"
    assert u.complexity == "medium"
    assert m._json_stats["understand_ok"] == 1


def test_decompose_parses_prose_wrapped_tasks():
    payload = (
        '{"tasks":[{"task_id":"s1","role":"SearcherAgent","goal":"检索相关代码"},'
        '{"task_id":"s2","role":"CoderAgent","goal":"实现","depends_on":["s1"]}]}'
    )
    m = _master(_ProseAdapter(payload))
    u = TaskUnderstanding(intent="x", complexity="medium", suggested_roles=[], estimated_steps=2, needs_multiagent=True)
    tasks = m._decompose_via_model("做事", u)
    assert len(tasks) == 2
    assert tasks[0].role == "SearcherAgent"
    assert tasks[1].depends_on == ["s1"]
    assert m._json_stats["decompose_ok"] == 1


def test_evaluate_parses_prose_wrapped_json():
    payload = '{"satisfied":false,"score":0.4,"missing":["测试"],"suggestions":["补测试"]}'
    m = _master(_ProseAdapter(payload))
    conv = Conversation(master_goal="g")
    conv.results.append(TaskResult(task_id="s1", role="CoderAgent", success=True, output="done"))
    q = m._evaluate_via_model(conv, "原目标")
    assert q.satisfied is False
    assert q.score == 0.4
    assert m._json_stats["evaluate_ok"] == 1


def test_understand_falls_back_to_heuristic_on_error():
    m = _master(_BoomAdapter())
    u = m._understand_via_model("修复登录 bug")
    assert isinstance(u, TaskUnderstanding)  # 走 heuristic，未抛异常
    assert m._json_stats["understand_fail"] == 1


def test_multi_agent_path_exposes_json_parse():
    m = _master(_ProseAdapter('{"intent":"x"}'))
    # 轻量替换重协作者，避免真实模型/工具调用
    m._decompose = lambda ui, u: [Task(task_id="s1", role="CoderAgent", goal="g")]
    m._evaluate = lambda conv, ui: QualityAssessment(satisfied=True, score=1.0)
    m._dispatcher = SimpleNamespace(
        dispatch=lambda tasks, conv: [TaskResult(task_id="s1", role="CoderAgent", success=True, output="done", tokens_used=10)]
    )
    m._merger = SimpleNamespace(merge=lambda conv, ui: {"answer": "final"})

    u = TaskUnderstanding(intent="x", complexity="simple", suggested_roles=[], estimated_steps=1, needs_multiagent=True)
    out = m._multi_agent_path("do it", u)

    assert "observability" in out
    assert "json_parse" in out["observability"]
    assert set(out["observability"]["json_parse"]) >= {"understand_ok", "decompose_ok", "evaluate_ok"}
