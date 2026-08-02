"""P2-6 MasterAgent 编排层埋 Tracer span 验收测试。

覆盖：handle() 产出根 span multiagent.handle，其下嵌套 understand / pipeline /
decompose / dispatch.roundN / agent.<role> / evaluate / merge 子 span + summary；
P0-2 的 json_parse 仍并存；single 路径也带 trace。
"""

from types import SimpleNamespace

from arforge.multiagent.master_agent import MasterAgent, QualityAssessment, TaskUnderstanding
from arforge.multiagent.protocol import Task, TaskResult


def _names(node):
    out = [node["name"]]
    for c in node.get("children", []):
        out.extend(_names(c))
    return out


def _multi_master():
    m = MasterAgent(SimpleNamespace(adapter=SimpleNamespace()))
    m._understand = lambda ui: TaskUnderstanding(
        intent="x", complexity="complex", suggested_roles=[], estimated_steps=3, needs_multiagent=True
    )
    m._needs_multiagent = lambda u: True
    m._recall_context = lambda ui, top_k=5: ""
    m._decompose = lambda ui, u: [Task(task_id="s1", role="CoderAgent", goal="g")]
    m._dispatcher = SimpleNamespace(
        dispatch=lambda tasks, conv: [TaskResult(task_id="s1", role="CoderAgent", success=True, output="done", tokens_used=5)]
    )
    m._evaluate = lambda conv, ui: QualityAssessment(satisfied=True, score=1.0)
    m._merger = SimpleNamespace(merge=lambda conv, ui: {"answer": "final"})
    return m


def test_handle_produces_nested_stage_trace():
    out = _multi_master().handle("做个复杂任务")
    obs = out["observability"]
    tree = obs["trace"]
    assert tree["name"] == "multiagent.handle"

    names = _names(tree)
    for expected in ["understand", "multiagent.pipeline", "decompose", "dispatch.round1", "agent.CoderAgent", "evaluate", "merge"]:
        assert expected in names, f"缺少阶段 span: {expected}"

    assert "summary" in obs
    assert "json_parse" in obs  # P0-2 统计并存


def test_handle_summary_has_aggregate_fields():
    out = _multi_master().handle("任务")
    summary = out["observability"]["summary"]
    for key in ("total_tokens", "cost_cny", "duration_ms", "llm_calls", "tool_calls"):
        assert key in summary


def test_handle_single_path_also_traced():
    m = MasterAgent(None)
    m._understand = lambda ui: TaskUnderstanding(
        intent="x", complexity="simple", suggested_roles=[], estimated_steps=1, needs_multiagent=False
    )
    m._needs_multiagent = lambda u: False
    m._single_agent_path = lambda ui: {"answer": "hi", "mode": "single"}

    out = m.handle("你好")
    tree = out["observability"]["trace"]
    assert tree["name"] == "multiagent.handle"
    assert "understand" in _names(tree)
