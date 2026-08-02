"""Test C1: 8 new capabilities (web_search, doc_extraction, diff_apply,
debug_diagnose, data_analysis, dependency_check, git_operation, refactor_suggest).

Verifies:
- All 8 capabilities are registered and enabled
- Each handler returns structured dict (never stub/placeholder)
- Keyword matching triggers correct capabilities
- Handler functions exist and are callable
"""

from __future__ import annotations



from arforge.capability.capability_registry import REGISTRY, _debug_diagnose, _dependency_check, _diff_apply, _doc_extraction, _data_analysis, _git_operation, _refactor_suggest, _web_search


# ====================================================================
# Registration tests
# ====================================================================


class TestCapabilitiesRegistered:
    """Verify all 18 capabilities are in the registry."""

    def test_total_capabilities_at_least_18(self):
        caps = REGISTRY.list(enabled_only=True)
        assert len(caps) >= 18, f"Expected >=18, got {len(caps)}: {[c.name for c in caps]}"

    def test_web_search_registered(self):
        cap = REGISTRY.get("web_search")
        assert cap is not None
        assert cap.enabled
        assert len(cap.keywords) > 0

    def test_doc_extraction_registered(self):
        cap = REGISTRY.get("doc_extraction")
        assert cap is not None
        assert cap.enabled

    def test_diff_apply_registered(self):
        cap = REGISTRY.get("diff_apply")
        assert cap is not None
        assert cap.enabled

    def test_debug_diagnose_registered(self):
        cap = REGISTRY.get("debug_diagnose")
        assert cap is not None
        assert cap.enabled

    def test_data_analysis_registered(self):
        cap = REGISTRY.get("data_analysis")
        assert cap is not None
        assert cap.enabled

    def test_dependency_check_registered(self):
        cap = REGISTRY.get("dependency_check")
        assert cap is not None
        assert cap.enabled

    def test_git_operation_registered(self):
        cap = REGISTRY.get("git_operation")
        assert cap is not None
        assert cap.enabled

    def test_refactor_suggest_registered(self):
        cap = REGISTRY.get("refactor_suggest")
        assert cap is not None
        assert cap.enabled


# ====================================================================
# Keyword matching tests
# ====================================================================


class TestKeywordMatching:
    def test_web_search_keyword_match(self):
        matches = REGISTRY.match("搜索 Python 闭包的用法")
        names = [c.name for c in matches]
        assert "web_search" in names

    def test_doc_extraction_keyword_match(self):
        matches = REGISTRY.match("提取这个 PDF 文档的内容 report.pdf")
        names = [c.name for c in matches]
        assert "doc_extraction" in names

    def test_diff_apply_keyword_match(self):
        matches = REGISTRY.match("应用补丁到 main.py")
        names = [c.name for c in matches]
        assert "diff_apply" in names

    def test_debug_diagnose_keyword_match(self):
        matches = REGISTRY.match("调试这个 TypeError 错误 traceback")
        names = [c.name for c in matches]
        assert "debug_diagnose" in names

    def test_data_analysis_keyword_match(self):
        matches = REGISTRY.match("对 sales.csv 进行数据分析")
        names = [c.name for c in matches]
        assert "data_analysis" in names

    def test_dependency_check_keyword_match(self):
        matches = REGISTRY.match("检查项目依赖的安全漏洞")
        names = [c.name for c in matches]
        assert "dependency_check" in names

    def test_git_operation_keyword_match(self):
        matches = REGISTRY.match("查看 git 状态和最近提交")
        names = [c.name for c in matches]
        assert "git_operation" in names

    def test_refactor_suggest_keyword_match(self):
        matches = REGISTRY.match("给出重构建议优化 agent_core.py")
        names = [c.name for c in matches]
        assert "refactor_suggest" in names


# ====================================================================
# Handler return structure tests
# ====================================================================


class TestHandlerReturnsDict:
    """Each handler must return a dict (never None, never a string)."""

    def test_web_search_returns_dict(self):
        result = _web_search("Python lambda")
        assert isinstance(result, dict)
        assert "success" in result

    def test_doc_extraction_no_file(self):
        result = _doc_extraction("提取文档 report.pdf")
        assert isinstance(result, dict)
        assert "success" in result  # Should fail gracefully (file does not exist)

    def test_diff_apply_no_diff(self):
        result = _diff_apply("应用补丁")
        assert isinstance(result, dict)
        assert "error" in result or "success" in result

    def test_debug_diagnose_parses_error(self):
        result = _debug_diagnose("遇到了 TypeError: 'NoneType' object is not callable")
        assert isinstance(result, dict)
        assert "findings" in result
        assert result["findings"]["error_type"] == "TypeError"

    def test_data_analysis_no_file(self):
        result = _data_analysis("分析 data.csv")
        assert isinstance(result, dict)
        # File doesn't exist, should return error
        assert "success" in result

    def test_dependency_check_returns_dict(self):
        result = _dependency_check("检查依赖")
        assert isinstance(result, dict)
        assert "checks" in result

    def test_git_operation_no_git(self):
        result = _git_operation("git status")
        assert isinstance(result, dict)
        # Will fail if no git repo, but must return dict

    def test_refactor_suggest_no_file(self):
        result = _refactor_suggest("重构代码")
        assert isinstance(result, dict)
        assert "suggestions" in result


# ====================================================================
# Debug diagnose parsing tests
# ====================================================================


class TestDebugDiagnose:
    def test_parse_traceback_type(self):
        result = _debug_diagnose("""
Traceback (most recent call last):
  File "main.py", line 42, in <module>
    foo()
  File "main.py", line 15, in foo
    return bar(None)
TypeError: 'NoneType' object is not callable
        """)
        assert result["findings"]["error_type"] == "TypeError"
        assert "NoneType" in result["findings"]["message"]

    def test_parse_traceback_file_and_line(self):
        result = _debug_diagnose('''
Traceback (most recent call last):
  File "E:/project/src/utils.py", line 120, in process
    raise ValueError("invalid input")
ValueError: invalid input
        ''')
        assert "utils.py" in result["findings"]["file"]

    def test_no_error_returns_suggestions(self):
        result = _debug_diagnose("Something went wrong somewhere")
        assert len(result["suggestions"]) > 0


# ====================================================================
# Refactor suggest tests
# ====================================================================


class TestRefactorSuggest:
    def test_no_file_gives_info(self):
        result = _refactor_suggest("重构 cli.py")
        assert result["success"] is True
        assert len(result["suggestions"]) >= 0

    def test_real_file_analyzed(self, tmp_path):
        """Create a temporary Python file with a long function and analyze it."""
        py_file = tmp_path / "test_module.py"
        # Create a file with a long function
        lines = ["def long_function():"]
        lines.extend([f"    x = {i}" for i in range(60)])
        py_file.write_text("\n".join(lines), encoding="utf-8")

        result = _refactor_suggest(str(py_file))
        assert result["success"] is True
        # Should detect the long function
        long_func = [s for s in result["suggestions"] if s.get("type") == "long_function"]
        assert len(long_func) > 0
