"""P1-8 可观测性验收测试。

覆盖：Span 树嵌套 / 成本估算 / 聚合(token/成本/缓存命中率/计数) / 错误状态 /
JSON 导出 / run_agentic 真实埋点产出 observability。
"""

import pytest

import arforge.tools.basic_tools  # noqa: F401  注册真实工具
from arforge.core.agent_core import ArforgeAgent
from arforge.core.agent_loop_v2 import AgentLoopV2
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.observability import Tracer, aggregate, estimate_cost


# --------------------------- tracer 独立测试 ---------------------------


def test_span_tree_nesting():
    t = Tracer()
    with t.span("root") as root:
        with t.span("child-a"):
            pass
        with t.span("child-b"):
            pass
    assert root.name == "root"
    assert [c.name for c in root.children] == ["child-a", "child-b"]
    assert all(c.parent_id == root.span_id for c in root.children)
    assert root.end is not None


def test_estimate_cost():
    # deepseek-chat: prompt 0.002, completion 0.008, cache_hit 0.0005 (per 1k)
    cost = estimate_cost("deepseek-chat", prompt_tokens=1000, completion_tokens=200, cache_hit_tokens=800)
    # non_cached=200 → 0.0004; cache 800 → 0.0004; completion 200 → 0.0016 ; 合计 0.0024
    assert cost == pytest.approx(0.0024)
    assert estimate_cost("unknown-model", 100, 100) == 0.0


def test_aggregate_tokens_cost_and_counts():
    t = Tracer()
    root = t.start_span("agent.run")
    s1 = t.start_span("llm.call")
    t.record_llm(s1, model="deepseek-chat", prompt_tokens=1000, completion_tokens=100, cache_hit_tokens=600)
    t.end_span(s1)
    ts = t.start_span("tool.calculate", kind="tool")
    t.end_span(ts, status="ok")
    terr = t.start_span("tool.broken", kind="tool")
    t.end_span(terr, status="error")
    t.end_span(root)

    agg = aggregate(root)
    assert agg["llm_calls"] == 1
    assert agg["tool_calls"] == 2
    assert agg["total_tokens"] == 1100
    assert agg["cache_hit_tokens"] == 600
    assert agg["cache_hit_rate"] == pytest.approx(0.6)
    assert agg["errors"] == 1
    assert agg["cost_cny"] > 0


def test_span_error_status_via_context_manager():
    t = Tracer()
    with pytest.raises(ValueError):
        with t.span("risky"):
            raise ValueError("boom")
    assert t.root.status == "error"
    assert "boom" in t.root.attributes.get("error", "")


def test_span_to_dict_structure():
    t = Tracer()
    with t.span("root") as root:
        with t.span("tool.x", kind="tool"):
            pass
    d = root.to_dict()
    assert d["name"] == "root"
    assert "duration_ms" in d
    assert d["children"][0]["name"] == "tool.x"


# --------------------------- run_agentic 集成埋点 ---------------------------


class _TracedAdapter:
    model_name = "deepseek-chat"

    def __init__(self, script):
        self.script = script
        self.idx = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kwargs):
        resp = self.script[min(self.idx, len(self.script) - 1)]
        self.idx += 1
        return resp


def _usage(p, c, hit):
    return {"prompt_tokens": p, "completion_tokens": c, "total_tokens": p + c, "prompt_cache_hit_tokens": hit}


def test_run_agentic_produces_observability_trace():
    script = [
        ToolCallResponse(
            content="",
            finish_reason="tool_calls",
            tool_calls=[ToolCall("c1", "calculate", '{"expression":"2+2"}')],
            usage=_usage(1000, 50, 800),
        ),
        ToolCallResponse(content="结果是 4", finish_reason="stop", tool_calls=[], usage=_usage(1100, 20, 900)),
    ]
    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    agent._adapter = _TracedAdapter(script)
    result = AgentLoopV2(agent).run_agentic("2+2?", max_steps=5)

    obs = result.observability
    assert obs is not None
    summary = obs["summary"]
    assert summary["llm_calls"] == 2
    assert summary["tool_calls"] == 1  # calculate
    assert summary["total_tokens"] == 1050 + 1120
    assert summary["cache_hit_tokens"] == 1700
    assert summary["cost_cny"] > 0
    # trace 树根为 agent.run，且含 llm.call 与 tool.calculate
    tree = obs["trace"]
    assert tree["name"] == "agent.run"
    names = _collect_names(tree)
    assert "llm.call" in names
    assert "tool.calculate" in names


def _collect_names(node):
    names = [node["name"]]
    for child in node.get("children", []):
        names.extend(_collect_names(child))
    return names
