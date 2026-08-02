"""Tests for fork_subagent.py — context-inheriting sub-agent spawn."""
from arforge.multiagent.fork_subagent import (
    ForkSubAgentConfig,
    ForkResult,
    build_fork_system_prompt,
    is_fork_depth_exceeded,
    format_fork_result_for_parent,
)
from arforge.multiagent.agent_types import EXPLORER_AGENT


class TestForkSubAgentConfig:
    def test_defaults(self):
        cfg = ForkSubAgentConfig(task="Test task")
        assert cfg.task == "Test task"
        assert cfg.permission_mode == "acceptEdits"
        assert cfg.inherit_tools is True
        assert cfg.agent_type is None

    def test_custom_agent_type(self):
        cfg = ForkSubAgentConfig(task="Explore", agent_type=EXPLORER_AGENT)
        assert cfg.agent_type == EXPLORER_AGENT


class TestBuildForkSystemPrompt:
    def test_inherits_parent_prompt(self):
        parent = "You are a helpful assistant."
        prompt = build_fork_system_prompt(parent, "Fix bug in foo.py")
        assert parent in prompt
        assert "Fix bug in foo.py" in prompt

    def test_includes_agent_type_prompt(self):
        parent = "Base system prompt."
        prompt = build_fork_system_prompt(parent, "Explore codebase", EXPLORER_AGENT)
        assert "Base system prompt" in prompt
        assert "Explore codebase" in prompt
        assert "exploration" in prompt.lower()

    def test_default_to_general_purpose(self):
        parent = "Base."
        prompt = build_fork_system_prompt(parent, "Task", None)
        assert "general" in prompt.lower() or "General-purpose" in prompt

    def test_extra_system_added(self):
        parent = "Base."
        prompt = build_fork_system_prompt(parent, "Task", extra="Extra context here")
        assert "Extra context here" in prompt


class TestForkDepthGuard:
    def test_no_forks(self):
        assert not is_fork_depth_exceeded([])

    def test_one_fork(self):
        msgs = [{"role": "user", "content": "[FORK:completed] Done"}]
        assert not is_fork_depth_exceeded(msgs)

    def test_exceeds_depth(self):
        msgs = [
            {"role": "user", "content": "[FORK:completed]"},
            {"role": "user", "content": "[FORK:completed]"},
            {"role": "user", "content": "[FORK:completed]"},
            {"role": "user", "content": "[FORK:completed]"},
        ]
        assert is_fork_depth_exceeded(msgs, max_depth=3)

    def test_custom_max_depth(self):
        msgs = [{"role": "user", "content": "[FORK:completed]"}] * 2
        assert is_fork_depth_exceeded(msgs, max_depth=1)


class TestFormatForkResult:
    def test_success_result(self):
        result = ForkResult(answer="Fixed the bug", success=True, steps_used=5)
        msg = format_fork_result_for_parent(result)
        assert msg["role"] == "user"
        assert "[FORK:completed]" in msg["content"]
        assert "Fixed the bug" in msg["content"]

    def test_failure_result(self):
        result = ForkResult(answer="", success=False, error="Permission denied")
        msg = format_fork_result_for_parent(result)
        assert "[FORK:failed]" in msg["content"]
        assert "Permission denied" in msg["content"]


class TestForkResult:
    def test_defaults(self):
        r = ForkResult(answer="ok", success=True)
        assert r.steps_used == 0
        assert r.tool_calls == []
        assert r.error is None

    def test_with_steps(self):
        r = ForkResult(answer="done", success=True, steps_used=10)
        assert r.steps_used == 10
