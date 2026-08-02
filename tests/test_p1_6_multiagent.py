"""P1-6 多 Agent 升级验收测试。

覆盖：SubAgent 工具白名单过滤 / SubAgent 用真实工具循环(run_agentic_task)执行任务
（取代单次 prompt，复用 core.agentic.run_tool_loop）。
用 ScriptedAdapter 注入受控模型响应，工具用真实注册的 calculate。
"""

from types import SimpleNamespace

import arforge.tools.basic_tools  # noqa: F401  注册真实工具
import arforge.tools.file_tools  # noqa: F401
import arforge.tools.task_tools  # noqa: F401
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


class _CalcAgent(SubAgent):
    role = "CalcAgent"
    tools = ["calculate"]
    system_prompt = "你是计算器代理。"


class _AnyAgent(SubAgent):
    role = "AnyAgent"
    tools = []  # 空白名单 → 可用全部工具


class _ScriptedAdapter:
    model_name = "deepseek-chat"

    def __init__(self, script):
        self.script = script
        self.idx = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kwargs):
        resp = self.script[min(self.idx, len(self.script) - 1)]
        self.idx += 1
        return resp


def _master_with(adapter):
    return SimpleNamespace(agent=SimpleNamespace(adapter=adapter))


def test_subagent_tool_whitelist_filters():
    tools = _CalcAgent()._allowed_tools()
    names = [t["function"]["name"] for t in tools]
    assert names == ["calculate"]  # 只暴露白名单内的工具


def test_subagent_empty_whitelist_gets_all_tools():
    assert len(_AnyAgent()._allowed_tools()) >= 12


def test_subagent_runs_real_tool_loop():
    script = [
        ToolCallResponse(
            content="",
            finish_reason="tool_calls",
            tool_calls=[ToolCall("c1", "calculate", '{"expression":"6*7"}')],
        ),
        ToolCallResponse(content="答案是 42", finish_reason="stop", tool_calls=[]),
    ]
    agent = _CalcAgent(_master_with(_ScriptedAdapter(script)))
    result = agent.run_agentic_task(Task(task_id="t1", goal="计算 6*7"), None, max_steps=5)

    assert result.answer == "答案是 42"
    # 工具真实执行且成功（非空壳）
    assert any(tc["tool"] == "calculate" and tc["success"] for tc in result.tool_calls)
    # 复用了可观测层
    assert result.observability is not None
    assert result.observability["summary"]["tool_calls"] == 1


def test_subagent_agentic_immediate_answer():
    script = [ToolCallResponse(content="无需工具，直接回答", finish_reason="stop", tool_calls=[])]
    agent = _CalcAgent(_master_with(_ScriptedAdapter(script)))
    result = agent.run_agentic_task(Task(task_id="t2", goal="打个招呼"), None)
    assert result.answer == "无需工具，直接回答"
    assert result.tool_calls == []
