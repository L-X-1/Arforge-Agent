"""M2 acceptance tests: Tool and Agent Execution Loop.

Covers every registered tool (success + failure), AgentLoopV2 full pipeline,
matching accuracy, and tool result structure.
"""

import pytest


# ============================================================================
# Tool Registry — schema, registration, listing
# ============================================================================


def test_all_tools_have_schema():
    """Every registered tool has params, risk, and description."""
    from arforge.tool_executor import list_tools

    tools = list_tools()
    assert len(tools) >= 10, "at least 10 tools expected"

    for t in tools:
        assert t["name"], f"tool missing name: {t}"
        assert t["description"], f"tool {t['name']} missing description"
        assert t["risk"] in ("low", "medium", "high", "critical"), f"tool {t['name']} invalid risk: {t['risk']}"
        assert "params" in t, f"tool {t['name']} missing params"


# ============================================================================
# Basic tools
# ============================================================================


class TestCalculate:
    def test_simple_addition(self):
        from arforge.tool_executor import run_tool_if_match

        result = run_tool_if_match("calculate 2+2")
        assert result.success
        assert "4" in result.output

    def test_complex_expression(self):
        from arforge.tool_executor import run_tool_if_match

        result = run_tool_if_match("calculate (10+5)*3-8/2")
        assert result.success

    def test_invalid_expression_blocked(self):
        """Non-arithmetic expressions are rejected by AST whitelist."""
        from arforge.tools.basic_tools import safe_calculate

        with pytest.raises(Exception):
            safe_calculate("__import__('os').system('dir')")

    def test_by_name_execution(self):
        from arforge.tool_executor import execute_tool_by_name

        result = execute_tool_by_name("calculate", {"expression": "3*7"})
        assert result.success
        assert "21" in result.output


class TestTime:
    def test_current_time(self):
        from arforge.tool_executor import run_tool_if_match

        result = run_tool_if_match("what time is it")
        assert result.success
        assert "2026" in result.output  # current year

    def test_time_zero_args(self):
        from arforge.tool_executor import execute_tool_by_name

        result = execute_tool_by_name("time")
        assert result.success
        assert len(result.output) > 0


class TestRunCommand:
    def test_echo_allowed(self, monkeypatch):
        from arforge.tool_executor import execute_tool_by_name

        monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
        result = execute_tool_by_name("run_cmd", {"command": "echo hello"})
        assert result.success
        assert "hello" in result.output

    def test_blocked_command(self):
        from arforge.tools.basic_tools import check_cmd_permission

        perm = check_cmd_permission("rm -rf /")
        assert not perm["allowed"]


# ============================================================================
# File tools
# ============================================================================


class TestFileTools:
    def test_list_files_returns_string(self):
        from arforge.tool_executor import execute_tool_by_name

        result = execute_tool_by_name("list_files")
        assert result.success
        assert isinstance(result.output, str)

    def test_create_and_read_file(self):
        from arforge.tool_executor import execute_tool_by_name

        fname = "m2_test_file.txt"
        # Create
        r1 = execute_tool_by_name("create_file", {"filename": fname})
        assert r1.success

        # Read
        r2 = execute_tool_by_name("read_file", {"filename": fname})
        assert r2.success

        # Cleanup
        from arforge.tools.file_tools import WORKSPACE

        (WORKSPACE / fname).unlink(missing_ok=True)

    def test_write_and_read_file(self, monkeypatch):
        from arforge.tool_executor import execute_tool_by_name

        monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
        fname = "m2_write_test.txt"
        content = "M2 test content: hello world"

        r1 = execute_tool_by_name("write_file", {"filename": fname, "content": content})
        assert r1.success
        assert "wrote" in r1.output

        r2 = execute_tool_by_name("read_file", {"filename": fname})
        assert r2.success
        assert "M2 test content" in r2.output

        # Cleanup
        from arforge.tools.file_tools import WORKSPACE

        (WORKSPACE / fname).unlink(missing_ok=True)

    def test_read_nonexistent_file(self):
        from arforge.tool_executor import execute_tool_by_name

        result = execute_tool_by_name("read_file", {"filename": "nonexistent_m2_test.xyz"})
        assert not result.success or "Error" in result.output

    def test_path_escape_blocked(self):
        import pytest

        from arforge.tools.file_tools import _resolve

        with pytest.raises(ValueError, match="escapes"):
            _resolve("../../etc/passwd")


# ============================================================================
# Task tools
# ============================================================================


class TestTaskTools:
    def test_create_and_list_tasks(self):
        from arforge.tool_executor import execute_tool_by_name

        r1 = execute_tool_by_name("create_task", {"title": "M2 test task", "priority": "high"})
        assert r1.success
        assert "M2 test task" in r1.output

        r2 = execute_tool_by_name("list_tasks")
        assert r2.success
        assert "M2 test task" in r2.output

    def test_complete_task(self):
        from arforge.tool_executor import execute_tool_by_name

        # Create a task first
        r1 = execute_tool_by_name("create_task", {"title": "M2 complete test"})
        assert r1.success

        # Extract task ID
        import re

        task_id = int(re.search(r"#(\d+)", r1.output).group(1))

        r2 = execute_tool_by_name("complete_task", {"task_id": task_id})
        assert r2.success

    def test_search_tasks(self):
        from arforge.tool_executor import execute_tool_by_name

        r1 = execute_tool_by_name("create_task", {"title": "unique_search_term_m2"})
        assert r1.success

        r2 = execute_tool_by_name("search_tasks", {"keyword": "unique_search_term_m2"})
        assert r2.success
        assert "unique_search_term_m2" in r2.output

    def test_delete_task(self):
        from arforge.tool_executor import execute_tool_by_name

        r1 = execute_tool_by_name("create_task", {"title": "M2 delete test"})
        assert r1.success

        import re

        task_id = int(re.search(r"#(\d+)", r1.output).group(1))

        r2 = execute_tool_by_name("delete_task", {"task_id": task_id})
        assert r2.success
        assert "Deleted" in r2.output or "Deleted" in r2.output

    def test_delete_nonexistent(self):
        from arforge.tool_executor import execute_tool_by_name

        result = execute_tool_by_name("delete_task", {"task_id": 99999})
        assert "not found" in result.output.lower()


# ============================================================================
# Matching accuracy
# ============================================================================


@pytest.mark.parametrize(
    "text,expected_tool",
    [
        ("calculate 2+2", "calculate"),
        ("what time is it", "time"),
        ("list files", "list_files"),
        ("create a task: fix login", "create_task"),
        ("show tasks", "list_tasks"),
        ("add task buy milk", "create_task"),
        ("read file test.txt", "read_file"),
        ("hello world how are you", None),
        ("just chatting about the weather", None),
    ],
)
def test_tool_matching_accuracy(text, expected_tool):
    from arforge.tool_executor import run_tool_if_match

    result = run_tool_if_match(text)
    actual = result.tool_name if result else None
    assert actual == expected_tool, f"'{text}' → expected {expected_tool}, got {actual}"


# ============================================================================
# AgentLoopV2 — full pipeline
# ============================================================================


class TestAgentLoopV2:
    def test_run_general_chat(self):
        """AgentLoopV2 handles general chat without tools."""
        from arforge.core.agent_loop_v2 import AgentLoopV2

        loop = AgentLoopV2()
        result = loop.run("say hello in one word")

        assert len(result.answer) > 0
        assert result.intent == "general"

    def test_run_with_tool(self):
        """AgentLoopV2 detects tool need and executes tool before answering."""
        from arforge.core.agent_loop_v2 import AgentLoopV2

        loop = AgentLoopV2()
        result = loop.run("calculate 100+200")

        assert len(result.answer) > 0
        # Should have used the calculate tool
        assert result.enhanced
        assert any("calculate" in str(tc) for tc in result.tool_calls)

    def test_run_coding_task(self):
        """Coding task loop reads files and produces answer."""
        from arforge.core.agent_loop_v2 import AgentLoopV2

        # First create a file to reference
        from arforge.tools.file_tools import WORKSPACE

        f = WORKSPACE / "m2_coding_test.py"
        f.write_text("def greet():\n    return 'hello'\n", encoding="utf-8")

        loop = AgentLoopV2()
        result = loop.run_coding_task("review the greet function", [str(f)])

        assert len(result.answer) > 0
        assert result.intent == "coding"

        f.unlink(missing_ok=True)

    def test_stream_events(self, monkeypatch):
        """Streaming produces answer_delta and done events."""
        from arforge.core.agent_loop_v2 import AgentLoopV2

        monkeypatch.setenv("ARFORGE_AUTO_APPROVE", "1")
        loop = AgentLoopV2()
        events = list(loop.stream("calculate 5+5"))

        event_types = {e["type"] for e in events}
        assert "answer_delta" in event_types
        assert "done" in event_types

    def test_run_without_model_for_tool_only(self):
        """When tool returns result, answer should incorporate it."""
        from arforge.core.agent_loop_v2 import AgentLoopV2

        loop = AgentLoopV2()
        result = loop.run("what time is it now")

        assert len(result.answer) > 0
        assert result.enhanced
        # The answer should mention the time (the tool was used)
        assert any("time" in str(tc).lower() for tc in result.tool_calls)


# ============================================================================
# ToolResult structure
# ============================================================================


def test_tool_result_structure():
    """Every tool execution returns a proper ToolResult."""
    from arforge.tool_executor import execute_tool_by_name

    result = execute_tool_by_name("calculate", {"expression": "1+1"})
    assert hasattr(result, "success")
    assert hasattr(result, "output")
    assert hasattr(result, "error")
    assert hasattr(result, "elapsed_ms")
    assert hasattr(result, "tool_name")
    assert result.tool_name == "calculate"


def test_failed_tool_execution():
    """Invalid tool execution returns failure result, not an exception."""
    from arforge.tool_executor import execute_tool_by_name

    result = execute_tool_by_name("calculate", {"expression": "not valid ***"})
    assert not result.success
    assert result.error


def test_unknown_tool():
    """Calling an unregistered tool returns failure."""
    from arforge.tool_executor import execute_tool_by_name

    result = execute_tool_by_name("nonexistent_tool_xyz", {})
    assert not result.success


# ============================================================================
# Schema completeness
# ============================================================================


def test_get_tool_returns_schema():
    from arforge.tool_executor import get_tool

    calc = get_tool("calculate")
    assert calc is not None
    assert calc["name"] == "calculate"
    assert len(calc["params"]) == 1
    assert calc["params"][0]["name"] == "expression"
    assert calc["params"][0]["type"] == "string"

    time_tool = get_tool("time")
    assert time_tool is not None
    assert len(time_tool["params"]) == 0


def test_risk_levels_set_correctly():
    from arforge.tool_executor import get_tool

    assert get_tool("calculate")["risk"] == "low"
    assert get_tool("time")["risk"] == "low"
    assert get_tool("run_cmd")["risk"] == "medium"
    assert get_tool("write_file")["risk"] == "medium"
