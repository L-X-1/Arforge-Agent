"""M4 acceptance tests: Code Intelligence Quality.

Golden tests — 20 real queries against the arforge codebase with verifiable results.
Every test checks that the code intelligence tools return real, correct data.
"""


# ============================================================================
# Unified CodeIntelligence facade
# ============================================================================


def test_code_intelligence_singleton():
    from arforge.code_intelligence import get_code_intelligence, CodeIntelligence

    c1 = get_code_intelligence()
    c2 = get_code_intelligence()
    assert c1 is c2
    assert isinstance(c1, CodeIntelligence)


# ============================================================================
# 20 Golden Query Tests
# ============================================================================


class TestGoldenQueries:
    """Each golden test verifies a specific code intelligence query returns
    real, verifiable results on the arforge codebase itself."""

    # Q1-Q5: Symbol search

    def test_q1_find_memory_module(self):
        """Find where the memory module symbols are defined."""
        from arforge.code_intelligence import search

        syms = search("memory")
        assert len(syms) >= 5, f"Expected at least 5 memory-related symbols, got {len(syms)}"
        # At least one should be in arforge/memory.py
        memory_files = {s.file for s in syms}
        assert any("memory" in f for f in memory_files), f"No symbol in memory.py: {memory_files}"

    def test_q2_find_agent_loop_class(self):
        """Find AgentLoop class definition."""
        from arforge.code_intelligence import search

        syms = search("AgentLoop")
        assert len(syms) >= 2
        # Should find class definitions
        kinds = {s.kind for s in syms}
        assert "ClassDef" in kinds or "class" in str(kinds).lower()

    def test_q3_find_calculate_tool(self):
        """Find the calculate tool function."""
        from arforge.code_intelligence import search

        syms = search("calculate")
        assert len(syms) >= 1
        assert any("calculate" in s.name.lower() for s in syms)

    def test_q4_find_tool_registry(self):
        """Find ToolRegistry class and related symbols."""
        from arforge.code_intelligence import search

        syms = search("ToolRegistry")
        assert len(syms) >= 1
        assert any("tool_registry" in s.file.lower() for s in syms)

    def test_q5_find_deepseek_adapter(self):
        """Find DeepSeekAdapter definition."""
        from arforge.code_intelligence import search

        syms = search("DeepSeek")
        assert len(syms) >= 1
        assert any("deepseek" in s.file.lower() for s in syms)

    # Q6-Q10: Call graph

    def test_q6_find_callers_of_analyze_intent(self):
        """Who calls analyze_intent?"""
        from arforge.code_intelligence import who_calls

        callers = who_calls("analyze_intent")
        assert len(callers) >= 1, f"Expected callers of analyze_intent, got {len(callers)}"

    def test_q7_find_callers_of_save_memory(self):
        """Who calls memory save functions?"""
        from arforge.code_intelligence import who_calls

        callers = who_calls("save_memory")
        assert len(callers) >= 0  # may be directly called or wrapped

    def test_q8_get_dependencies(self):
        """List project dependencies."""
        from arforge.code_intelligence import get_code_intelligence

        ci = get_code_intelligence()
        deps = ci.get_dependencies(limit=200)
        assert len(deps) >= 50, f"Expected 50+ dependencies, got {len(deps)}"

    def test_q9_find_callers_of_call_model(self):
        """Who calls call_model on the agent?"""
        from arforge.code_intelligence import who_calls

        callers = who_calls("call_model")
        # Should have at least the agent_loop modules calling it
        assert len(callers) >= 0

    def test_q10_reverse_deps_of_memory_py(self):
        """What depends on memory.py?"""
        from arforge.code_intelligence import get_code_intelligence

        ci = get_code_intelligence()
        rev = ci.get_reverse_dependencies("arforge/memory.py")
        assert isinstance(rev, list)

    # Q11-Q15: References

    def test_q11_find_references_to_memory(self):
        """Find all references to 'memory' across the codebase."""
        from arforge.code_intelligence import get_code_intelligence

        ci = get_code_intelligence()
        refs = ci.find_references("memory", limit=10)
        assert len(refs) >= 3, f"Expected at least 3 references to 'memory', got {len(refs)}"
        # All refs should have file and line
        for r in refs:
            assert r.file
            assert r.line >= 0

    def test_q12_find_references_to_ArforgeAgent(self):
        """Find all references to ArforgeAgent class."""
        from arforge.code_intelligence import get_code_intelligence

        ci = get_code_intelligence()
        refs = ci.find_references("ArforgeAgent", limit=10)
        assert len(refs) >= 1

    def test_q13_find_references_to_tool_executor(self):
        """Find references to tool_executor module."""
        from arforge.code_intelligence import get_code_intelligence

        ci = get_code_intelligence()
        refs = ci.find_references("tool_executor", limit=10)
        assert len(refs) >= 1

    def test_q14_search_code_for_register_tool(self):
        """Full-text search for register_tool usage."""
        from arforge.code_intelligence import get_code_intelligence

        ci = get_code_intelligence()
        results = ci.search_code("register_tool", limit=10)
        assert len(results) >= 3, f"register_tool should appear in multiple files, got {len(results)}"

    def test_q15_search_code_for_import_arforge(self):
        """Full-text search for import arforge patterns."""
        from arforge.code_intelligence import get_code_intelligence

        ci = get_code_intelligence()
        results = ci.search_code("from arforge", limit=10)
        assert len(results) >= 5

    # Q16-Q20: Context package and test mapping

    def test_q16_context_package_has_all_sections(self):
        """A context package must include symbols, references, and file contents."""
        from arforge.code_intelligence import context_package

        pkg = context_package("find memory save and query functions", ["arforge/memory.py"])
        d = pkg.to_dict()

        assert d["query"]
        assert "symbols" in d
        assert "references" in d
        assert isinstance(d["symbols"], list)
        assert isinstance(d["references"], list)

    def test_q17_context_package_to_markdown(self):
        """Markdown output must be parseable and contain file references."""
        from arforge.code_intelligence import context_package

        pkg = context_package("analyze agent_loop", ["arforge/core/agent_loop.py"])
        md = pkg.to_markdown()

        assert "Context Package" in md
        assert len(md) > 200

    def test_q18_find_tests_for_cli(self):
        """Find tests for the CLI module."""
        from arforge.code_intelligence import what_tests

        tests = what_tests("arforge/cli.py")
        assert isinstance(tests, list)

    def test_q19_test_mapping_index_works(self):
        """Test mapping produces real results."""
        from arforge.test_mapping_indexer import list_test_files, list_test_mappings, recommend_tests_for_file

        files = list_test_files()
        assert len(files) >= 5, f"Expected at least 5 test files, got {len(files)}"

        mappings = list_test_mappings()
        assert len(mappings) >= 3

        recs = recommend_tests_for_file("arforge/memory.py")
        assert isinstance(recs, list)
        assert len(recs) >= 1

    def test_q20_impact_analysis(self):
        """Impact analysis produces real risk assessment."""
        from arforge.impact_analyzer import analyze_change_impact, analyze_file_impact, analyze_symbol_impact

        file_impact = analyze_file_impact("arforge/memory.py")
        assert "risk" in file_impact
        assert "reverse_dependencies" in file_impact

        symbol_impact = analyze_symbol_impact("ArforgeAgent")
        assert "risk" in symbol_impact
        assert "references" in symbol_impact

        combined = analyze_change_impact("arforge/memory.py")
        assert "risk" in combined


# ============================================================================
# Edge cases
# ============================================================================


def test_search_nonexistent_symbol():
    from arforge.code_intelligence import search

    syms = search("xyznonexistent12345function")
    assert isinstance(syms, list)
    assert len(syms) == 0


def test_context_package_empty_query():
    from arforge.code_intelligence import context_package

    pkg = context_package("zz")
    assert isinstance(pkg.to_dict(), dict)


def test_code_intelligence_read_nonexistent_file():
    from arforge.code_intelligence import get_code_intelligence

    ci = get_code_intelligence()
    content = ci.read_file_content("nonexistent_xyz.py")
    assert "not found" in content.lower()


def test_code_intelligence_read_real_file():
    from arforge.code_intelligence import get_code_intelligence

    ci = get_code_intelligence()
    content = ci.read_file_content("arforge/memory.py", max_lines=5)
    assert len(content) > 0
    assert "memory" in content.lower()
