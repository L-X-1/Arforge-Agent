"""P0-2 Agentic Loop 验收测试。

覆盖：LLM 驱动的多步工具循环 / 模型自主停止 / 死循环熔断 / max_steps 强制收尾 /
非法工具参数失败回灌。用 ScriptedAdapter 注入受控模型响应（不依赖真实 API），
工具用真实注册的 calculate / time。
"""

import arforge.tools.basic_tools  # noqa: F401  注册真实工具
import arforge.tools.file_tools  # noqa: F401
import arforge.tools.task_tools  # noqa: F401
import arforge.tools.test_runner_tools  # noqa: F401
from arforge.core.agent_core import ArforgeAgent
from arforge.core.agent_loop_v2 import AgentLoopV2
from arforge.models.model_adapter import ToolCall, ToolCallResponse
from arforge.tool_registry import REGISTRY


class ScriptedAdapter:
    """按脚本顺序返回 ToolCallResponse；记录每次调用以便断言。"""

    def __init__(self, script):
        self.script = script
        self.idx = 0
        self.calls = []

    def generate_with_tools(self, messages, tools=None, tool_choice="auto", **kwargs):
        self.calls.append({"tools_provided": tools is not None, "n_messages": len(messages)})
        resp = self.script[min(self.idx, len(self.script) - 1)]
        self.idx += 1
        return resp


def _tc(call_id, name, arguments):
    return ToolCallResponse(
        content="", finish_reason="tool_calls", tool_calls=[ToolCall(call_id, name, arguments)]
    )


def _final(text):
    return ToolCallResponse(content=text, finish_reason="stop", tool_calls=[])


def _loop(script):
    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    agent._adapter = ScriptedAdapter(script)
    return AgentLoopV2(agent), agent._adapter


def test_agentic_multi_step_tool_then_answer():
    loop, adapter = _loop([
        _tc("c1", "calculate", '{"expression":"2+2"}'),
        _final("结果是 4。"),
    ])
    result = loop.run_agentic("2+2 等于几？", max_steps=5)

    assert result.answer == "结果是 4。"
    # 工具真的被执行且成功（非空壳）
    assert any(c["tool"] == "calculate" and c["success"] for c in result.tool_calls)
    events = [e["event"] for e in result.trace]
    assert "tool" in events
    assert "final" in events
    # 第二轮调用模型时，上下文里已含工具结果（消息增多 = 真的回灌了观察）
    assert adapter.calls[1]["n_messages"] > adapter.calls[0]["n_messages"]


def test_agentic_no_tool_immediate_answer():
    loop, _ = _loop([_final("你好！")])
    result = loop.run_agentic("打个招呼", max_steps=5)
    assert result.answer == "你好！"
    assert result.tool_calls == []
    assert result.messages[-1] == {"role": "assistant", "content": "你好！"}


def test_agentic_loop_detection():
    loop, _ = _loop([
        _tc("c1", "calculate", '{"expression":"2+2"}'),
        _tc("c2", "calculate", '{"expression":"2+2"}'),  # 完全相同的调用
        _final("收尾回答"),
    ])
    result = loop.run_agentic("算 2+2", max_steps=10)
    events = [e["event"] for e in result.trace]
    assert "loop_detected" in events
    assert result.answer == "收尾回答"


def test_agentic_max_steps_finalize():
    loop, _ = _loop([
        _tc("c1", "calculate", '{"expression":"1+1"}'),
        _tc("c2", "calculate", '{"expression":"2+2"}'),
        _final("最终收尾"),
    ])
    result = loop.run_agentic("连续计算", max_steps=2)
    events = [e["event"] for e in result.trace]
    assert "max_steps_reached" in events
    assert result.answer == "最终收尾"


def test_read_only_audit_reserves_last_step_for_evidence_delivery():
    loop, adapter = _loop([
        _tc("c1", "calculate", '{"expression":"2+2"}'),
        _final("Read-only audit result: the executed calculation returned 4."),
    ])
    result = loop.run_agentic(
        "Perform a read-only audit. Do not edit files.",
        max_steps=2,
    )

    assert result.answer.startswith("Read-only audit result")
    assert result.self_correct["stop_reason"] == "final"
    assert result.incomplete_report is None
    assert adapter.calls[1]["tools_provided"] is False
    assert any(item["event"] == "budget_synthesis_reserved" for item in result.trace)


def test_budget_report_falls_back_to_executed_evidence_when_model_repeats_tool_markup():
    loop, adapter = _loop([
        _tc("c1", "calculate", '{"expression":"2+2"}'),
        _final('<tool_call>{"name":"calculate","arguments":{"expression":"3+3"}}</tool_call>'),
        _final('<tool_call>{"name":"calculate","arguments":{"expression":"4+4"}}</tool_call>'),
    ])
    result = loop.run_agentic(
        "Perform a read-only audit. Do not edit files.",
        max_steps=2,
    )

    calculations = [call for call in result.tool_calls if call["tool"] == "calculate"]
    assert len(calculations) == 1
    assert "Executed tools: 1 (1 passed, 0 failed)" in result.answer
    assert "calculate [passed]" in result.answer
    assert result.self_correct["stop_reason"] == "max_steps"
    assert any(item["event"] == "budget_tool_call_blocked" for item in result.trace)
    assert adapter.calls[2]["tools_provided"] is False


def test_explicit_incomplete_delivery_cannot_be_recorded_as_success():
    loop, _ = _loop([
        _tc("c1", "calculate", '{"expression":"2+2"}'),
        _final("The task is not completed. Cleanup was not executed."),
    ])
    result = loop.run_agentic(
        "Create one disposable fixture, verify it, then delete it and perform cleanup.",
        max_steps=4,
    )

    assert result.self_correct["stop_reason"] == "task_incomplete"
    assert result.incomplete_report is not None
    assert any(item["event"] == "task_incomplete_declared" for item in result.trace)


def test_browser_evidence_digest_preserves_early_mutation_and_visible_state():
    from arforge.core.agentic import _render_executed_evidence

    calls = [
        {
            "step": 1,
            "tool": "interact_browser",
            "args": {"url": "http://127.0.0.1", "actions": ["fill:#title:E2E-Probe"]},
            "success": True,
            "output": (
                "Final URL: http://127.0.0.1/\n"
                "Viewport: 1280x720\n"
                "Document: 1280x900; horizontal_overflow=false\n"
                "Actions completed: [\"filled #title\"]\n"
                "Runtime issues: 0\n"
                "Visible text sample: E2E-Probe created successfully"
            ),
        }
    ]
    calls.extend(
        {
            "step": index,
            "tool": "code_read",
            "args": {"filename": f"file_{index}.py"},
            "success": True,
            "output": "source evidence",
        }
        for index in range(2, 28)
    )

    digest = _render_executed_evidence(calls)
    assert "E2E-Probe created successfully" in digest
    assert "Actions completed" in digest
    assert "horizontal_overflow=false" in digest


def test_browser_cleanup_requires_delete_and_absence_snapshot():
    from arforge.core.agentic import _browser_cleanup_verified

    calls = [
        {
            "tool": "interact_browser",
            "args": {"actions": ["click:.ttb-del"]},
            "success": True,
            "output": "Runtime issues: 0\nVisible text sample: remaining tasks",
        }
    ]
    assert _browser_cleanup_verified(
        "Create a disposable task named E2E-Probe and delete it during cleanup.", calls
    )
    calls[0]["output"] += " E2E-Probe"
    assert not _browser_cleanup_verified(
        "Create a disposable task named E2E-Probe and delete it during cleanup.", calls
    )


def test_browser_url_claim_is_grounded_by_executed_runtime_evidence():
    from arforge.core.agentic import _has_grounding_tool_evidence

    calls = [
        {
            "tool": "test_browser",
            "args": {"url": "http://127.0.0.1:8200/?p=tasks"},
            "success": True,
            "output": (
                "Final URL: http://127.0.0.1:8200/?p=tasks\n"
                "Runtime issues: 0\nVisible text sample: task page"
            ),
        }
    ]
    assert _has_grounding_tool_evidence(
        "Verified http://127.0.0.1:8200/?p=tasks in the browser.", calls
    )


def test_named_test_files_become_one_deterministic_run_tests_call():
    from arforge.core.agentic import (
        _build_explicit_runtime_tool_call,
        _explicit_tool_requests,
    )

    task = (
        "Run exactly tests/test_alpha.py and tests/test_beta.py::test_case, "
        "then report the exact count."
    )
    tools = REGISTRY.to_openai_tools()
    assert "run_tests" in _explicit_tool_requests(task, tools)
    call = _build_explicit_runtime_tool_call(task, "run_tests", step=1)
    assert call is not None
    assert call.name == "run_tests"
    assert call.arguments == (
        '{"targets": ["tests/test_alpha.py", "tests/test_beta.py::test_case"], '
        '"framework": "pytest"}'
    )


def test_future_test_file_does_not_force_validation_before_creation():
    from arforge.core.agentic import (
        _build_explicit_runtime_tool_call,
        _explicit_tool_requests,
    )

    task = "新增 tests/test_regression.py 覆盖边界，并运行全部 pytest。"
    tools = REGISTRY.to_openai_tools()

    assert "run_tests" not in _explicit_tool_requests(task, tools)
    assert _build_explicit_runtime_tool_call(
        task, "run_tests", step=1
    ) is None


def test_agentic_invalid_tool_args_feeds_error_back():
    loop, _ = _loop([
        _tc("c1", "calculate", "NOT-JSON"),  # 非法 JSON → 空参数 → 缺必填 → 失败
        _final("已根据错误纠正"),
    ])
    result = loop.run_agentic("test", max_steps=5)
    assert any(not c["success"] for c in result.tool_calls)
    assert result.answer == "已根据错误纠正"
