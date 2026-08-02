"""Test A3: AgentLoopV2 verify + retry — full intent→execute→verify→retry→synthesize loop.

Verifies that:
- _verify_tool_result correctly validates calculator / time / file_read / run_cmd
- _run_with_retry retries on verification failure (with backoff)
- LoopResult includes verifications and retry_count
- Retries are exhausted gracefully (max_retries respected)
- Tools without verification rules are skipped (not failed)
- Trace records contain verify/retry steps
"""

from __future__ import annotations

import pytest

from arforge.core.agent_loop_v2 import AgentLoopV2, _build_tool_prompt
from arforge.tool_registry import ToolResult, ToolMatch


# ====================================================================
# Helpers
# ====================================================================


@pytest.fixture
def loop():
    """Fresh AgentLoopV2 with max_retries=2 for fast exhaustion tests."""
    return AgentLoopV2(max_retries=2)


# ====================================================================
# Test 1: _verify_tool_result — all built-in rules
# ====================================================================


class TestVerifyToolResult:
    """Direct unit tests for _verify_tool_result."""

    def test_calculator_valid_number_passes(self, loop):
        result = ToolResult("calculator", True, "42", "", 0)
        v = loop._verify_tool_result("calculator", result)
        assert v["passed"]
        assert v["method"] == "float_parse"

    def test_calculator_non_numeric_fails(self, loop):
        result = ToolResult("calculator", True, "not a number", "", 0)
        v = loop._verify_tool_result("calculator", result)
        assert not v["passed"]
        assert "not a valid number" in v["reason"]

    def test_calculator_failed_execution_fails(self, loop):
        result = ToolResult("calculator", False, "", "math error", 0)
        v = loop._verify_tool_result("calculator", result)
        assert not v["passed"]
        assert v["method"] == "execution_failed"

    def test_time_iso_passes(self, loop):
        result = ToolResult("time", True, "2026-06-18 12:30:45 UTC", "", 0)
        v = loop._verify_tool_result("time", result)
        assert v["passed"]
        assert v["method"] == "iso_regex"

    def test_time_missing_iso_fails(self, loop):
        result = ToolResult("time", True, "unknown time", "", 0)
        v = loop._verify_tool_result("time", result)
        assert not v["passed"]
        assert "ISO 8601" in v["reason"]

    def test_read_file_non_empty_passes(self, loop):
        result = ToolResult("read_file", True, "file contents here", "", 0)
        v = loop._verify_tool_result("read_file", result)
        assert v["passed"]
        assert v["method"] == "non_empty"

    def test_read_file_empty_fails(self, loop):
        result = ToolResult("read_file", True, "", "", 0)
        v = loop._verify_tool_result("read_file", result)
        assert not v["passed"]

    def test_read_file_whitespace_only_fails(self, loop):
        result = ToolResult("read_file", True, "   \n  ", "", 0)
        v = loop._verify_tool_result("read_file", result)
        assert not v["passed"]

    def test_run_cmd_passes(self, loop):
        result = ToolResult("run_cmd", True, "command output", "", 0, meta={"returncode": 0})
        v = loop._verify_tool_result("run_cmd", result)
        assert v["passed"]
        assert v["method"] == "returncode_check"

    def test_run_cmd_no_meta_still_passes(self, loop):
        """run_cmd without returncode in meta still passes (loose check)."""
        result = ToolResult("run_cmd", True, "some output", "", 0)
        v = loop._verify_tool_result("run_cmd", result)
        assert v["passed"]
        assert v["method"] == "skipped"

    def test_unknown_tool_skips_verification(self, loop):
        """Tools without rules should pass verification (skip, not fail)."""
        result = ToolResult("unknown_tool", True, "whatever", "", 0)
        v = loop._verify_tool_result("unknown_tool", result)
        assert v["passed"]
        assert v["method"] == "skipped"

    def test_tool_execution_failure_always_fails_verify(self, loop):
        """If tool execution itself failed, verify should fail regardless of tool."""
        result = ToolResult("calculator", False, "", "execution error", 0)
        v = loop._verify_tool_result("calculator", result)
        assert not v["passed"]
        assert v["method"] == "execution_failed"


# ====================================================================
# Test 2: _run_with_retry — success on first attempt
# ====================================================================


def test_retry_success_on_first_attempt(loop, monkeypatch):
    """When verify passes on first try, no retries should occur."""
    call_count = 0

    def fake_execute(match):
        nonlocal call_count
        call_count += 1
        return ToolResult(match.tool_name, True, "42", "", 0)

    monkeypatch.setattr("arforge.core.agent_loop_v2.REGISTRY.execute", fake_execute)

    match = ToolMatch("calculator", {"expression": "2+2"})
    result, log = loop._run_with_retry(match)

    assert result is not None
    assert result.success
    assert call_count == 1  # Only one attempt
    # Log should contain only verify (passed), no retry
    verify_entries = [e for e in log if e["step"] == "verify"]
    retry_entries = [e for e in log if e["step"] == "retry"]
    assert len(verify_entries) == 1
    assert verify_entries[0]["passed"]
    assert len(retry_entries) == 0


# ====================================================================
# Test 3: _run_with_retry — single retry then success
# ====================================================================


def test_retry_single_retry_then_success(loop, monkeypatch):
    """When first verification fails, tool should retry and succeed."""
    call_count = 0

    def fake_execute(match):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            # First call: "success" but non-numeric output
            return ToolResult("calculator", True, "bad output", "", 0)
        # Retry: valid output
        return ToolResult("calculator", True, "42", "", 0)

    monkeypatch.setattr("arforge.core.agent_loop_v2.REGISTRY.execute", fake_execute)

    match = ToolMatch("calculator", {"expression": "2+2"})
    result, log = loop._run_with_retry(match)

    assert result is not None
    assert result.success
    assert call_count == 2  # Original + 1 retry
    retry_entries = [e for e in log if e["step"] == "retry"]
    assert len(retry_entries) == 1
    assert retry_entries[0]["attempt"] == 1


# ====================================================================
# Test 4: _run_with_retry — retries exhausted
# ====================================================================


def test_retry_exhausted(loop, monkeypatch):
    """When all attempts fail verification, retries should be exhausted."""
    call_count = 0

    def fake_execute(match):
        nonlocal call_count
        call_count += 1
        return ToolResult("calculator", True, f"bad_{call_count}", "", 0)

    monkeypatch.setattr("arforge.core.agent_loop_v2.REGISTRY.execute", fake_execute)

    match = ToolMatch("calculator", {"expression": "2+2"})
    result, log = loop._run_with_retry(match)

    assert result is not None
    # All verification attempts failed — max_retries reached
    assert call_count == loop.max_retries  # max_retries=2
    exhausted = [e for e in log if e["step"] == "retries_exhausted"]
    assert len(exhausted) == 1


# ====================================================================
# Test 5: run() — LoopResult includes verifications and retry_count
# ====================================================================


def test_loop_result_has_verifications_and_retry_count(monkeypatch):
    """LoopResult should include verifications and retry_count fields."""
    from arforge.intent_analyzer import Intent
    from arforge.reasoning import ReasoningResult

    # Force intent to need tool
    def fake_intent(user_input):
        return Intent(category="general", needs_tool=True)

    monkeypatch.setattr("arforge.core.agent_loop_v2.analyze_intent", fake_intent)

    # Make REGISTRY.match return a match for calculator
    def fake_match(user_input):
        return ToolMatch("calculator", {"expression": "2+2"})

    monkeypatch.setattr("arforge.core.agent_loop_v2.REGISTRY.match", fake_match)

    def fake_execute(match):
        return ToolResult("calculator", True, "42", "", 0)

    monkeypatch.setattr("arforge.core.agent_loop_v2.REGISTRY.execute", fake_execute)

    loop = AgentLoopV2(max_retries=2)
    monkeypatch.setattr(
        loop.agent,
        "call_model_with_reasoning",
        lambda _prompt: ReasoningResult(answer="42", parse_success=True),
    )
    result = loop.run("calculate 2+2")

    assert isinstance(result.verifications, list)
    assert isinstance(result.retry_count, int)
    assert result.retry_count == 0  # No retries needed
    assert len(result.verifications) >= 1
    assert result.verifications[0]["passed"]
    assert result.verifications[0]["tool"] == "calculator"


# ====================================================================
# Test 6: Trace records verify and retry steps
# ====================================================================


def test_trace_records_verify_steps(loop, monkeypatch):
    """Trace should include verify step records."""
    def fake_execute(match):
        return ToolResult("calculator", True, "42", "", 0)

    monkeypatch.setattr("arforge.core.agent_loop_v2.REGISTRY.execute", fake_execute)

    match = ToolMatch("calculator", {"expression": "2+2"})
    _result, log = loop._run_with_retry(match)

    verify_steps = [e for e in log if e["step"] == "verify"]
    assert len(verify_steps) >= 1
    assert verify_steps[0]["tool"] == "calculator"
    assert "method" in verify_steps[0]


# ====================================================================
# Test 7: Verify fails but tool reports success (mismatch handling)
# ====================================================================


def test_verify_fail_but_tool_success(loop):
    """When tool.execution succeeds but verify output is invalid, verify should fail."""
    result = ToolResult("calculator", True, "garbage", "", 0)
    v = loop._verify_tool_result("calculator", result)
    assert not v["passed"]
    # Tool did not error — its output just didn't pass verification
    assert v["method"] != "execution_failed"


# ====================================================================
# Test 8: Skip verify for tool without rules
# ====================================================================


def test_skip_verify_for_unknown_tool_in_retry_loop(loop, monkeypatch):
    """_run_with_retry should succeed immediately for tools without rules."""
    def fake_execute(match):
        return ToolResult(match.tool_name, True, "some output", "", 0)

    monkeypatch.setattr("arforge.core.agent_loop_v2.REGISTRY.execute", fake_execute)

    match = ToolMatch("list_files", {"path": "."})
    result, log = loop._run_with_retry(match)

    assert result is not None
    assert result.success
    # Should succeed on first attempt (verification skipped, not failed)
    verify_entries = [e for e in log if e["step"] == "verify"]
    assert len(verify_entries) == 1
    assert verify_entries[0]["passed"]
    assert verify_entries[0]["method"] == "skipped"


# ====================================================================
# Test 9: _build_tool_prompt no longer duplicates tool descriptions
# ====================================================================


def test_build_tool_prompt_does_not_duplicate_tools():
    """_build_tool_prompt should NOT contain the full tool table (system prompt has it)."""
    prompt = _build_tool_prompt("calculate 2+2")
    # Old format had "Available tools" prefix; new format is just user request
    assert "Available tools" not in prompt
    assert "User request:" in prompt


# ====================================================================
# Test 10: AgentLoopV2 accepts max_retries parameter
# ====================================================================


def test_agent_loop_v2_custom_max_retries():
    """AgentLoopV2 should accept custom max_retries."""
    loop = AgentLoopV2(max_retries=5)
    assert loop.max_retries == 5

    loop2 = AgentLoopV2(max_retries=1)
    assert loop2.max_retries == 1


# ====================================================================
# Test 11: Retry backoff increases with attempts
# ====================================================================


def test_retry_backoff_increases(loop, monkeypatch):
    """Retry delays should use exponential backoff (0.1, 0.2, 0.4...)."""
    call_count = 0
    delays = []

    def fake_execute(match):
        nonlocal call_count
        call_count += 1
        return ToolResult("calculator", True, "bad", "", 0)

    def fake_sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr("arforge.core.agent_loop_v2.REGISTRY.execute", fake_execute)
    monkeypatch.setattr("arforge.core.agent_loop_v2.time.sleep", fake_sleep)

    match = ToolMatch("calculator", {"expression": "2+2"})
    _result, _log = loop._run_with_retry(match)

    if len(delays) >= 1:
        assert delays[0] == pytest.approx(0.1, 0.01)
    if len(delays) >= 2:
        assert delays[1] == pytest.approx(0.2, 0.01)
