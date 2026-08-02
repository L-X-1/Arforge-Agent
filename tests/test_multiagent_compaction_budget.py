"""多 Agent 接入压缩/预算链 验收测试（HK-4 续）。

覆盖：run_agentic_task 始终安装自动压缩 hook；配置子 Agent 预算后子 Agent 工具循环超预算即中止。
"""

from types import SimpleNamespace

import pytest

import config
from arforge.core.hooks import HookEvent, get_hook_manager, reset_hook_manager
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))  # 隔离审计日志
    reset_hook_manager()
    yield
    reset_hook_manager()


class _LoopAgent(SubAgent):
    role = "LoopAgent"
    tools = ["noop"]


class _FinalAdapter:
    model_name = "deepseek-v4-flash"

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kw):
        return ToolCallResponse("done", "stop", [], {"total_tokens": 50})


class _NoopLoopAdapter:
    """每步返回一个不同参数的工具调用（永不收尾），每次 usage=100 token。"""

    model_name = "deepseek-v4-flash"

    def __init__(self):
        self.calls = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kw):
        self.calls += 1
        tc = ToolCall(f"c{self.calls}", "noop", f'{{"i": {self.calls}}}')
        return ToolCallResponse("", "tool_calls", [tc], {"total_tokens": 100})


def _agent(adapter):
    return _LoopAgent(SimpleNamespace(agent=SimpleNamespace(adapter=adapter)))


def test_run_agentic_task_installs_compaction_hook():
    agent = _agent(_FinalAdapter())
    agent.run_agentic_task(Task(task_id="t", goal="x"), None, max_steps=3)
    # 自动压缩 hook 已注册到 PRE_LLM_CALL（多 Agent 也享压缩）
    assert get_hook_manager().handler_count(HookEvent.PRE_LLM_CALL) >= 1


def test_subagent_budget_aborts(monkeypatch):
    monkeypatch.setattr(config, "SUBAGENT_RUN_TOKEN_BUDGET", 150)
    agent = _agent(_NoopLoopAdapter())
    res = agent.run_agentic_task(Task(task_id="t", goal="x"), None, max_steps=20)
    assert "运行中止" in res.answer  # 累计 200 > 150 → 中止


def test_subagent_no_budget_runs_normally(monkeypatch):
    monkeypatch.setattr(config, "SUBAGENT_RUN_TOKEN_BUDGET", 0)
    agent = _agent(_FinalAdapter())
    res = agent.run_agentic_task(Task(task_id="t", goal="x"), None, max_steps=3)
    assert res.answer == "done"  # 预算 0=不限，正常收尾
