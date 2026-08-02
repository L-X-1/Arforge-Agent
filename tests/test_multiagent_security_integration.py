"""P0-1 多 Agent 安全边界接线 验收测试。

覆盖：token 预算运行时强制(execute) / 路径沙箱强制(run_agentic_task 安全 executor) /
DataAgent capability↔tool 一致性 / 全角色 command_execution⟹run_cmd 不变量。
"""

from types import SimpleNamespace

import arforge.tools.basic_tools  # noqa: F401  注册真实工具
import arforge.tools.file_tools  # noqa: F401
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.multiagent.agents import (
    CoderAgent,
    DataAgent,
    DebuggerAgent,
    DocAgent,
    PlannerAgent,
    ReviewerAgent,
    SearcherAgent,
    TesterAgent,
)
from arforge.multiagent.protocol import Task
from arforge.multiagent.sub_agent import SubAgent

_ALL_AGENTS = [
    PlannerAgent, CoderAgent, ReviewerAgent, TesterAgent,
    SearcherAgent, DocAgent, DebuggerAgent, DataAgent,
]


# ----------------------------- token 预算 -----------------------------


class _GreedyAgent(SubAgent):
    role = "GreedyAgent"
    max_tokens = 100

    def _run(self, task, conversation):
        self._last_tokens = 999_999  # 远超预算
        return "一些输出", {}, [], []


class _FrugalAgent(SubAgent):
    role = "FrugalAgent"
    max_tokens = 10_000

    def _run(self, task, conversation):
        self._last_tokens = 50
        return "正常输出", {}, [], []


def test_token_budget_exceeded_marks_failure():
    result = _GreedyAgent().execute(Task(task_id="t1", goal="x"), None)
    assert result.success is False
    assert "token budget" in result.error


def test_token_budget_within_passes():
    result = _FrugalAgent().execute(Task(task_id="t2", goal="x"), None)
    assert result.success is True
    assert result.tokens_used == 50


# ----------------------------- 路径沙箱 -----------------------------


class _WriterAgent(SubAgent):
    role = "WriterAgent"
    capabilities = ["safe_modify"]
    tools = ["write_file"]


class _ScriptedAdapter:
    model_name = "deepseek-chat"

    def __init__(self, script):
        self.script = script
        self.idx = 0

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kwargs):
        resp = self.script[min(self.idx, len(self.script) - 1)]
        self.idx += 1
        return resp


def test_path_sandbox_blocks_out_of_sandbox_write(tmp_path, monkeypatch):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))  # 隔离审计日志
    bad_path = "C:/Windows/System32/evil.txt"  # 沙箱外
    script = [
        ToolCallResponse(
            content="",
            finish_reason="tool_calls",
            tool_calls=[ToolCall("c1", "write_file", '{"filename":"%s","content":"x"}' % bad_path)],
        ),
        ToolCallResponse(content="已停止", finish_reason="stop", tool_calls=[]),
    ]
    agent = _WriterAgent(SimpleNamespace(agent=SimpleNamespace(adapter=_ScriptedAdapter(script))))
    result = agent.run_agentic_task(Task(task_id="t3", goal="写文件"), None, max_steps=4)

    # 工具被拒（写操作未真正执行）
    assert any(tc["tool"] == "write_file" and not tc["success"] for tc in result.tool_calls)
    # 审计日志记录了沙箱拦截
    audit = tmp_path / "multiagent_audit.log"
    assert audit.exists()
    assert "path_sandbox_blocked" in audit.read_text(encoding="utf-8")


# ----------------------------- 一致性不变量 -----------------------------


def test_data_agent_capability_tool_consistency():
    assert "command_execution" not in DataAgent.capabilities  # 修复：不再声明无对应工具的能力
    assert DataAgent.capabilities and DataAgent.tools


def test_all_agents_command_execution_implies_run_cmd():
    for agent in _ALL_AGENTS:
        if "command_execution" in agent.capabilities:
            assert "run_cmd" in agent.tools, f"{agent.role} 声明 command_execution 却无 run_cmd 工具"
