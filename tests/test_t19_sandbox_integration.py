"""Tests for T19: Sandbox enforcement integration into agentic tool loop."""

from __future__ import annotations

import pytest

from arforge.core.agentic import run_tool_loop
from arforge.security.sandbox_enforce import get_audit_trail


class _TC:
    def __init__(self, id, name, arguments):
        self.id = id
        self.name = name
        self.arguments = arguments


class _Resp:
    def __init__(self, content="", tool_calls=None, usage=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage = usage or {}
        self.finish_reason = "stop"


class FakeAdapter:
    model_name = "test-sandbox"

    def __init__(self, steps: list[_Resp]):
        self._steps = steps
        self._idx = 0

    def generate_with_tools(self, messages, tools=None, tool_choice=None):
        if self._idx < len(self._steps):
            resp = self._steps[self._idx]
            self._idx += 1
            return resp
        return _Resp("done")


@pytest.fixture(autouse=True)
def _clear_audit():
    get_audit_trail().clear()
    yield


class TestSandboxIntegration:
    def test_safe_tool_passes_through(self):
        adapter = FakeAdapter([
            _Resp("", [_TC("c1", "read_file", '{"path": "test.py"}')]),
        ])
        result = run_tool_loop(
            adapter,
            [{"role": "user", "content": "read test.py"}],
            tools=[{"type": "function", "function": {"name": "read_file"}}],
            task="safe read",
        )
        assert result.answer == "done"

    def test_dangerous_rm_blocked(self):
        adapter = FakeAdapter([
            _Resp("", [_TC("c1", "run_cmd", '{"command": "rm -rf /etc"}')]),
        ])
        result = run_tool_loop(
            adapter,
            [{"role": "user", "content": "delete etc"}],
            tools=[{"type": "function", "function": {"name": "run_cmd"}}],
            task="dangerous",
        )
        # Blocked tool gets error feedback; model responds with final answer
        assert result.answer == "done"
        assert len(result.tool_calls) == 1
        assert not result.tool_calls[0]["success"]

    def test_sandbox_audit_trail(self):
        adapter = FakeAdapter([
            _Resp("", [_TC("c1", "run_cmd", '{"command": "echo hello"}')]),
        ])
        run_tool_loop(
            adapter,
            [{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "run_cmd"}}],
            task="safe cmd",
        )
        stats = get_audit_trail().stats()
        assert stats["total"] >= 1

    def test_blocked_does_not_crash_loop(self):
        """Even with a blocked tool, the loop completes normally."""
        adapter = FakeAdapter([
            _Resp("", [_TC("c1", "run_cmd", '{"command": "sudo rm -rf /"}')]),
        ])
        result = run_tool_loop(
            adapter,
            [{"role": "user", "content": "bad"}],
            tools=[{"type": "function", "function": {"name": "run_cmd"}}],
            task="bad cmd",
        )
        assert result.answer == "done"
