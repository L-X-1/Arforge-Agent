from __future__ import annotations

import pytest

from arforge.core.agentic import ToolLoopResult, _answer_declares_incomplete
from arforge.core.agent_loop_v2 import AgentLoopV2


class _Adapter:
    reasoning_effort = "medium"


class _Agent:
    def __init__(self, effort: str):
        self.adapter = _Adapter()
        self.reasoning_effort = effort
        self.multiagent_enabled = True

    def _should_use_structured_reasoning(self, _task: str) -> bool:
        return False

    def build_messages(self, task: str, use_reasoning: bool = False):  # noqa: ARG002
        return [
            {"role": "system", "content": "system"},
            {"role": "user", "content": task},
        ]


@pytest.mark.parametrize(
    ("effort", "expected_roles"),
    [
        ("low", []),
        ("medium", []),
        ("high", ["explore"]),
        ("ultra", ["researcher", "reviewer"]),
    ],
)
def test_reasoning_depth_deterministically_dispatches_required_subagents(
    monkeypatch,
    effort,
    expected_roles,
):
    calls: list[str] = []
    events: list[dict] = []

    def fake_subagent(_assignment: str, *, role: str, **_kwargs):
        calls.append(role)
        return f"{role} evidence"

    def fake_tool_loop(_adapter, messages, **_kwargs):
        return ToolLoopResult(answer="done", messages=list(messages))

    monkeypatch.setattr("arforge.core.subagent.run_subagent", fake_subagent)
    monkeypatch.setattr("arforge.core.agentic.run_tool_loop", fake_tool_loop)

    result = AgentLoopV2(_Agent(effort)).run_agentic(
        "inspect and verify",
        on_subagent=events.append,
    )

    assert calls == expected_roles
    assert [item["role"] for item in result.subagents] == expected_roles
    assert all(item["status"] == "completed" for item in result.subagents)
    assert len(events) == len(expected_roles) * 2
    if expected_roles:
        assert "Required sub-agent work has completed" in result.messages[-1]["content"]


def test_goal_mode_continues_from_checkpoint_until_completion(monkeypatch):
    loop = AgentLoopV2(_Agent("medium"))
    resumes: list[list[dict] | None] = []
    notes: list[str] = []

    def fake_run_agentic(_task: str, **kwargs):
        resumes.append(kwargs.get("resume_messages"))
        if len(resumes) == 1:
            return ToolLoopResult(
                answer="partial",
                steps=2,
                messages=[{"role": "assistant", "content": "checkpoint"}],
                tool_calls=[{"tool": "read_file"}],
                incomplete_report={"remaining": ["tests"]},
                self_correct={"stop_reason": "max_steps"},
                subagents=[{"role": "explore", "status": "completed"}],
            )
        return ToolLoopResult(
            answer="verified complete",
            steps=1,
            messages=[{"role": "assistant", "content": "verified complete"}],
            tool_calls=[{"tool": "run_cmd"}],
            verifications=[{"passed": True}],
        )

    monkeypatch.setattr(loop, "run_agentic", fake_run_agentic)

    result = loop.run_goal(
        "finish the project",
        max_steps=2,
        on_intermediate=notes.append,
    )

    assert len(resumes) == 2
    assert resumes[0] is None
    assert resumes[1][-1]["role"] == "user"
    assert "Do not ask the user to type continue" in resumes[1][-1]["content"]
    assert notes and "第 2 轮" in notes[0]
    assert result.answer == "verified complete"
    assert result.goal_mode is True
    assert result.goal_cycles == 2
    assert result.steps == 3
    assert len(result.tool_calls) == 2
    assert result.subagents == [{"role": "explore", "status": "completed"}]


def test_goal_mode_continues_when_delivered_report_lists_unverified_work(monkeypatch):
    loop = AgentLoopV2(_Agent("medium"))
    resumes: list[list[dict] | None] = []

    def fake_run_agentic(_task: str, **kwargs):
        resumes.append(kwargs.get("resume_messages"))
        if len(resumes) == 1:
            return ToolLoopResult(
                answer=(
                    "## Audit report\n\n"
                    "### 无法验证的事项\n"
                    "- 移动端导航尚未测试\n"
                    "- 算法列表仍疑似存在布局问题"
                ),
                steps=2,
                messages=[{"role": "assistant", "content": "premature report"}],
                tool_calls=[{"tool": "test_browser", "success": True}],
                verifications=[{"passed": True}],
            )
        return ToolLoopResult(
            answer="verified complete",
            steps=1,
            messages=[{"role": "assistant", "content": "verified complete"}],
            tool_calls=[{"tool": "run_cmd", "success": True}],
            verifications=[{"passed": True}],
        )

    monkeypatch.setattr(loop, "run_agentic", fake_run_agentic)

    result = loop.run_goal("finish every interaction check", max_steps=2)

    assert len(resumes) == 2
    assert resumes[1][-1]["role"] == "user"
    assert "resolve every unfinished item" in resumes[1][-1]["content"]
    assert result.answer == "verified complete"
    assert result.goal_cycles == 2
    assert any(
        item.get("event") == "goal_completion_claim_rejected"
        for item in result.trace
    )


def test_goal_mode_rejects_academic_artifacts_that_bypass_tool_loop_gate(monkeypatch):
    loop = AgentLoopV2(_Agent("medium"))
    resumes: list[list[dict] | None] = []
    quality_checks = 0

    def fake_quality_gate(_task: str, tool_calls: list[dict]):
        nonlocal quality_checks
        quality_checks += 1
        if quality_checks == 1:
            assert len(tool_calls) == 1
            return ["thesis.docx: visible populated table of contents was not found"]
        assert len(tool_calls) == 2
        return []

    def fake_run_agentic(_task: str, **kwargs):
        resumes.append(kwargs.get("resume_messages"))
        if len(resumes) == 1:
            # Simulate a max-step/deliver_user_message path that reports
            # success without carrying the canonical loop's incomplete report.
            return ToolLoopResult(
                answer="all academic artifacts delivered",
                steps=4,
                messages=[{"role": "assistant", "content": "premature delivery"}],
                tool_calls=[{"tool": "create_document", "success": True}],
            )
        return ToolLoopResult(
            answer="corrected and verified",
            steps=2,
            messages=[{"role": "assistant", "content": "corrected"}],
            tool_calls=[{"tool": "create_document", "success": True}],
            verifications=[{"passed": True}],
        )

    monkeypatch.setattr(
        "arforge.core.agentic._academic_artifact_quality_issues",
        fake_quality_gate,
    )
    monkeypatch.setattr(loop, "run_agentic", fake_run_agentic)

    result = loop.run_goal(
        "Create a standard-format thesis and proposal",
        max_steps=4,
    )

    assert result.answer == "corrected and verified"
    assert result.goal_cycles == 2
    assert "visible populated table of contents" in resumes[1][-1]["content"]
    assert any(
        item.get("reason") == "academic_artifact_quality_failed"
        for item in result.trace
    )


def test_empty_unverified_section_does_not_force_another_goal_cycle():
    assert _answer_declares_incomplete(
        "### 无法验证的事项\n- 移动端导航尚未测试"
    )
    assert not _answer_declares_incomplete("### 无法验证的事项\n- 无")


def test_subagent_inherits_model_deadline_and_operation_guard(monkeypatch):
    from arforge.core import subagent

    captured: dict[str, object] = {}

    def fake_tool_loop(_adapter, _messages, **kwargs):
        captured.update(kwargs)
        return ToolLoopResult(answer="bounded report")

    monkeypatch.setattr("arforge.core.agentic.run_tool_loop", fake_tool_loop)
    subagent.set_subagent_adapter(_Adapter())
    try:
        result = subagent.run_subagent(
            "inspect the workspace",
            role="explore",
            max_steps=3,
            should_stop=lambda: False,
            model_timeout_seconds=12,
            timeout_seconds=45,
        )
    finally:
        subagent.clear_subagent_adapter()

    assert result == "bounded report"
    assert captured["max_steps"] == 3
    assert captured["model_timeout_seconds"] == 12
    assert callable(captured["should_stop"])
    assert captured["should_stop"]() is False
