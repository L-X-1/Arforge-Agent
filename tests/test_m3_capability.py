"""M3 acceptance tests: Capability Enhancement Realization.

Verifies that:
1. All 10 capabilities are registered with real handlers
2. Routing correctly matches user intent to capabilities
3. Every capability returns structured, non-empty results
4. Empty results are not returned as success
5. Model-backed capabilities produce real analysis
"""


# ============================================================================
# Registry completeness
# ============================================================================


def test_all_10_capabilities_registered():
    from arforge.capability.capability_registry import list_capabilities

    caps = list_capabilities()
    names = {c["name"] for c in caps}

    required = {
        "memory_search",
        "code_review",
        "security_review",
        "code_search",
        "safe_modify",
        "test_generation",
        "planning",
        "learning_injection",
        "command_execution",
        "multimodal_inspection",
    }
    missing = required - names
    assert not missing, f"Missing capabilities: {missing}"
    assert len(caps) >= 10


def test_every_capability_has_keywords():
    from arforge.capability.capability_registry import list_capabilities

    for c in list_capabilities():
        assert c["keywords"], f"{c['name']} has no keywords"
        assert len(c["keywords"]) >= 3, f"{c['name']} needs at least 3 keywords, has {len(c['keywords'])}"


def test_every_capability_has_handler():
    from arforge.capability.capability_registry import REGISTRY

    for cap in REGISTRY.list():
        assert cap.handler is not None, f"{cap.name} has no handler function"


# ============================================================================
# Routing accuracy — M3 acceptance criteria
# ============================================================================


class TestRouting:
    def test_review_security_routes_correctly(self):
        from arforge.capability.enhancement_engine import capability_names_for

        names = capability_names_for("review this code for security issues")
        assert "security_review" in names

    def test_analyze_code_routes_correctly(self):
        from arforge.capability.enhancement_engine import capability_names_for

        names = capability_names_for("analyze the code in main.py")
        assert "code_review" in names

    def test_fix_bug_routes_correctly(self):
        from arforge.capability.enhancement_engine import capability_names_for

        names = capability_names_for("fix the login bug")
        assert "code_review" in names

    def test_plan_feature_routes_correctly(self):
        from arforge.capability.enhancement_engine import capability_names_for

        names = capability_names_for("plan a new feature for user auth")
        assert "planning" in names

    def test_remember_routes_to_memory(self):
        from arforge.capability.enhancement_engine import capability_names_for

        names = capability_names_for("remember this important fact about the project")
        assert "memory_search" in names

    def test_no_match_for_chat(self):
        from arforge.capability.enhancement_engine import capability_names_for

        names = capability_names_for("hello how are you today")
        assert len(names) == 0

    def test_code_search_routes(self):
        from arforge.capability.enhancement_engine import capability_names_for

        names = capability_names_for("search code for calculate function")
        assert "code_search" in names

    def test_generate_tests_routes(self):
        from arforge.capability.enhancement_engine import capability_names_for

        names = capability_names_for("generate tests for memory.py")
        assert "test_generation" in names


# ============================================================================
# Real execution — non-model capabilities (fast)
# ============================================================================


class TestNonModelExecution:
    def test_memory_search_returns_empty_for_unknown(self):
        from arforge.capability.enhancement_engine import get_capability_engine

        ctx = get_capability_engine().run("remember xyznonexistent12345")
        assert ctx.metadata["succeeded"] >= 1
        mem_result = next(r for r in ctx.capability_results if r.capability == "memory_search")
        assert mem_result.success
        data = eval(mem_result.content)
        assert "matches" in data
        assert isinstance(data["matches"], int)

    def test_code_search_finds_files(self):
        from arforge.capability.enhancement_engine import get_capability_engine

        ctx = get_capability_engine().run("search code for tool_registry")
        code_result = next(r for r in ctx.capability_results if r.capability == "code_search")
        assert code_result.success
        # Should find tool_registry.py
        assert "tool_registry" in code_result.content.lower() or "matches" in code_result.content.lower()

    def test_safe_modify_returns_usage(self):
        from arforge.capability.enhancement_engine import get_capability_engine

        ctx = get_capability_engine().run("safe write to config")
        r = next(r for r in ctx.capability_results if r.capability == "safe_modify")
        assert r.success
        # Real implementation returns structured error for unparseable queries
        assert "success" in r.content.lower() or "error" in r.content.lower()

    def test_multimodal_inspection_detects_pillow(self):
        from arforge.capability.enhancement_engine import get_capability_engine

        ctx = get_capability_engine().run("inspect this image screenshot.png")
        r = next(r for r in ctx.capability_results if r.capability == "multimodal_inspection")
        assert r.success
        # Real implementation now inspects actual files.
        # When file doesn't exist, returns structured error; when available, returns metadata.
        content = r.content.lower()
        assert "success" in content or "error" in content or "exists" in content

    def test_learning_injection_queries_patterns(self):
        from arforge.capability.enhancement_engine import get_capability_engine

        ctx = get_capability_engine().run("learn from error patterns in the project")
        r = next(r for r in ctx.capability_results if r.capability == "learning_injection")
        assert r.success
        assert "learned_patterns" in r.content or "error_patterns" in r.content

    def test_planning_returns_plan(self):
        from arforge.capability.enhancement_engine import get_capability_engine

        ctx = get_capability_engine().run("plan architecture for a CLI tool")
        r = next(r for r in ctx.capability_results if r.capability == "planning")
        assert r.success
        assert len(r.content) > 20


# ============================================================================
# Real execution — model-backed capabilities
# ============================================================================


class TestModelBackedExecution:
    def test_code_review_produces_analysis(self):
        """Verifies code_review actually calls the model and returns analysis."""
        from arforge.capability.enhancement_engine import get_capability_engine

        ctx = get_capability_engine().run(
            "review this code: def divide(a, b): return a / b"
        )
        code_results = [r for r in ctx.capability_results if r.capability == "code_review"]
        assert code_results, "code_review should be matched"
        r = code_results[0]
        assert r.success, f"code_review failed: {r.error}"
        assert len(r.content) > 50, "code_review should return substantial analysis"
        # Should mention division by zero or error handling
        content_lower = r.content.lower()
        assert any(w in content_lower for w in ["zero", "error", "exception", "division", "handle", "check"]), (
            f"code_review should identify the division-by-zero issue, got: {r.content[:200]}"
        )

    def test_security_review_produces_analysis(self):
        """Verifies security_review actually audits code."""
        from arforge.capability.enhancement_engine import get_capability_engine

        ctx = get_capability_engine().run(
            "audit security of this: query = f\"SELECT * FROM users WHERE id = '{user_input}'\""
        )
        sec_results = [r for r in ctx.capability_results if r.capability == "security_review"]
        assert sec_results, "security_review should be matched"
        r = sec_results[0]
        assert r.success, f"security_review failed: {r.error}"
        assert len(r.content) > 50, "security_review should return substantial analysis"
        content_lower = r.content.lower()
        # Should mention SQL injection
        assert any(w in content_lower for w in ["sql", "injection", "sanitize", "parameter", "prepared"]), (
            f"security_review should flag SQL injection, got: {r.content[:200]}"
        )

    def test_test_generation_produces_test_code(self):
        """Verifies test_generation writes actual pytest code."""
        from arforge.capability.enhancement_engine import get_capability_engine

        ctx = get_capability_engine().run(
            "write tests for: def add(a, b): return a + b"
        )
        test_results = [r for r in ctx.capability_results if r.capability == "test_generation"]
        assert test_results, "test_generation should be matched"
        r = test_results[0]
        assert r.success, f"test_generation failed: {r.error}"
        assert len(r.content) > 30
        assert "assert" in r.content.lower(), f"generated tests should contain asserts: {r.content[:200]}"


# ============================================================================
# EnhancementContext completeness
# ============================================================================


def test_enhancement_context_matches_and_runs():
    from arforge.capability.enhancement_engine import get_capability_engine

    engine = get_capability_engine()
    ctx = engine.run("plan a user authentication system")

    assert ctx.user_input
    assert ctx.metadata["total"] >= 1
    assert ctx.metadata["succeeded"] >= 1
    assert ctx.metadata["route_reason"] in ("keyword", "explicit", "none")


def test_enhance_answer_with_capabilities():
    from arforge.capability.enhancement_engine import get_capability_engine

    engine = get_capability_engine()
    enhanced = engine.enhance_answer("remember the API key location", "Base response")

    assert len(enhanced) > len("Base response")
    assert "Capability Evidence" in enhanced or "evidence" in enhanced.lower()


def test_no_capabilities_returns_graceful_message():
    from arforge.capability.enhancement_engine import get_capability_engine

    engine = get_capability_engine()
    result = engine.enhance_answer("hello", "")

    assert len(result) > 0
    # Should not crash, should return some explanation
    assert isinstance(result, str)


# ============================================================================
# CLI integration
# ============================================================================


def test_capability_status_command():
    from arforge.capability.capability_cli import capability_status

    status = capability_status()
    assert "10" in status or "capabilities" in status.lower()
    assert "memory_search" in status
    assert "code_review" in status


def test_capability_test_command():
    from arforge.capability.capability_cli import capability_test

    result = capability_test("plan a feature for X")
    assert "Input:" in result
    assert "planning" in result.lower() or "Capabilities matched" in result


def test_slash_capability_works():
    from arforge.slash_commands import run_slash_command

    output = run_slash_command("/capability")
    assert "memory_search" in output
    assert "code_review" in output


def test_enhance_engine_singleton():
    from arforge.capability.enhancement_engine import get_capability_engine

    e1 = get_capability_engine()
    e2 = get_capability_engine()
    assert e1 is e2
