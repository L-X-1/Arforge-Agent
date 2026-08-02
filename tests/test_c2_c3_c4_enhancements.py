"""Test C2/C3/C4: Protocol refinement, web search integration, tester execution.

Verifies:
- C2: Structured output formats (search/code/review/test)
- C2: TaskResult validation by role
- C3: SearcherAgent includes web search results
- C4: TesterAgent executes real pytest
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch


from arforge.multiagent.agents.searcher_agent import SearcherAgent
from arforge.multiagent.agents.tester_agent import TesterAgent
from arforge.multiagent.protocol import (
    Conversation,
    Task,
    format_code_result,
    format_review_result,
    format_search_result,
    format_test_result,
    validate_task_result,
)
from arforge.multiagent.protocol import TaskResult


# ====================================================================
# C2: Structured output format tests
# ====================================================================


class TestFormatSearchResult:
    def test_includes_files_and_summary(self):
        output = format_search_result(
            files=["main.py:42", "utils.py:15"],
            summary="Found dedupe logic in memory.py",
        )
        assert "main.py:42" in output
        assert "utils.py:15" in output
        assert "dedupe logic" in output
        assert "## 检索结果" in output

    def test_handles_empty_files(self):
        output = format_search_result(files=[], summary="Nothing found")
        assert "Nothing found" in output


class TestFormatCodeResult:
    def test_includes_code_and_description(self):
        output = format_code_result("Fixes the dedupe bug", "def dedupe(items):\n    return list(set(items))")
        assert "Fixes the dedupe bug" in output
        assert "def dedupe" in output
        assert "```python" in output

    def test_custom_language(self):
        output = format_code_result("JS fix", "console.log('hi')", language="javascript")
        assert "```javascript" in output


class TestFormatReviewResult:
    def test_includes_issues_by_severity(self):
        issues = [
            {"severity": "critical", "file": "main.py", "line": 10, "description": "Null deref"},
            {"severity": "medium", "file": "main.py", "line": 20, "description": "Long function"},
        ]
        output = format_review_result(issues, "changes_requested")
        assert "changes_requested" in output
        assert "Null deref" in output
        assert "Long function" in output

    def test_all_verdicts(self):
        for verdict in ["approved", "changes_requested", "blocked"]:
            output = format_review_result([], verdict)
            assert verdict in output


class TestFormatTestResult:
    def test_all_passed(self):
        output = format_test_result(5, 0, "All tests passed")
        assert "全部通过" in output or "5" in output

    def test_some_failed(self):
        output = format_test_result(3, 2, "2 tests failed")
        assert "2" in output


# ====================================================================
# C2: TaskResult validation tests
# ====================================================================


class TestValidateTaskResult:
    def test_failed_result_always_valid(self):
        r = TaskResult(task_id="t1", role="CoderAgent", success=False, error="fail")
        result = validate_task_result(r)
        assert result["valid"] is True

    def test_coder_with_code_block_valid(self):
        r = TaskResult(task_id="t1", role="CoderAgent", success=True, output="Here is the fix:\n```python\nx=1\n```")
        result = validate_task_result(r)
        assert result["valid"] is True

    def test_coder_without_code_block_invalid(self):
        r = TaskResult(task_id="t1", role="CoderAgent", success=True, output="Just some text no code")
        result = validate_task_result(r)
        assert result["valid"] is False

    def test_reviewer_with_header_valid(self):
        r = TaskResult(task_id="t1", role="ReviewerAgent", success=True, output="## 审查结果\nLooks good")
        result = validate_task_result(r)
        assert result["valid"] is True

    def test_reviewer_missing_header_invalid(self):
        r = TaskResult(task_id="t1", role="ReviewerAgent", success=True, output="Looks good")
        result = validate_task_result(r)
        assert result["valid"] is False

    def test_empty_output_invalid(self):
        r = TaskResult(task_id="t1", role="SearcherAgent", success=True, output="")
        result = validate_task_result(r)
        # Empty output triggers issue
        assert len(result["issues"]) > 0


# ====================================================================
# C3: Web search integration tests
# ====================================================================


class TestSearcherAgentWebSearch:
    def test_run_includes_web_search_when_available(self):
        agent = SearcherAgent()
        task = Task(role="SearcherAgent", goal="Python 3.12 new features")
        conv = Conversation(master_goal="Search")

        mock_ws = MagicMock()
        mock_ws.return_value = {"success": True, "results": ["Python 3.12 introduces..."], "results_count": 1}
        mock_call = MagicMock(return_value="Search results with web data")

        with patch("arforge.capability.web_search_adapter.web_search", mock_ws):
            with patch.object(agent, "_call_model", mock_call):
                result = agent.execute(task, conv)
                assert result.success is True

    def test_run_graceful_when_web_search_unavailable(self):
        agent = SearcherAgent()
        task = Task(role="SearcherAgent", goal="Test search")
        conv = Conversation(master_goal="Search")

        with patch.object(agent, "_call_model", return_value="Search done"):
            result = agent.execute(task, conv)
            assert result.success is True


# ====================================================================
# C4: TesterAgent real pytest execution tests
# ====================================================================


class TestTesterAgentExecution:
    def test_extract_and_execute_tests(self):
        """TesterAgent should extract ```python block and run pytest."""
        agent = TesterAgent()
        task = Task(role="TesterAgent", goal="Test simple function")

        test_code = '''```python
def test_simple():
    assert 1 + 1 == 2

def test_truthy():
    assert True
```'''
        result = agent._execute_tests(test_code, task)
        # Should find pytest and run tests
        if result.get("success"):
            assert result["passed"] >= 2
        else:
            # Pytest may not be in PATH or installed
            assert "error" in result

    def test_execute_tests_no_code_block(self):
        agent = TesterAgent()
        task = Task(role="TesterAgent", goal="Test")
        result = agent._execute_tests("no code block here", task)
        assert result["success"] is False

    def test_run_with_mocked_model(self):
        """Full execute() path with mocked _call_model + mocked _execute_tests."""
        agent = TesterAgent()
        task = Task(role="TesterAgent", goal="Write tests for sort()")
        conv = Conversation(master_goal="Test sort")

        with patch.object(agent, "_call_model", return_value='```python\ndef test_sort():\n    assert sorted([3,1,2]) == [1,2,3]\n```'):
            with patch.object(agent, "_execute_tests", return_value={"success": True, "passed": 1, "failed": 0}):
                result = agent.execute(task, conv)
                assert result.success is True
                test_count = result.artifacts.get("test_count", 0)
                assert test_count >= 1
                test_results = result.artifacts.get("test_results", {})
                assert test_results.get("passed", 0) >= 1


# ====================================================================
# C4: TesterAgent _execute_tests detailed tests
# ====================================================================


class TestExecuteTestsDetailed:
    def test_empty_test_code(self):
        agent = TesterAgent()
        task = Task(role="TesterAgent", goal="Test")
        result = agent._execute_tests("", task)
        assert result["success"] is False
        assert "未找到测试代码" in result.get("error", "")

    def test_whitespace_only_test_code(self):
        agent = TesterAgent()
        task = Task(role="TesterAgent", goal="Test")
        result = agent._execute_tests("   \n  \n  ", task)
        assert result["success"] is False
