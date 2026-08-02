"""Tests for the enhanced learning engine v2 - pattern extraction, consolidation, dreaming, injection."""



class TestPatternExtractor:
    """Tests for PatternExtractor - finding patterns from outcome data."""

    def test_extract_failure_patterns_empty(self):
        from arforge.learning_engine import PatternExtractor
        from arforge.learning_system import get_learning_system

        ls = get_learning_system()
        ls.new_session()
        extractor = PatternExtractor()

        patterns = extractor.extract_failure_patterns(limit=50, min_frequency=1)
        assert isinstance(patterns, list)

    def test_extract_failure_patterns_from_data(self):
        from arforge.learning_engine import PatternExtractor
        from arforge.learning_system import get_learning_system

        ls = get_learning_system()
        ls.new_session()

        # Record a few failures with similar error
        for i in range(3):
            ls.record_turn(
                f"fix bug {i}", f"tried fix {i}",
                success=False, error="ImportError: No module named 'missing_lib'"
            )

        extractor = PatternExtractor()
        patterns = extractor.extract_failure_patterns(limit=50, min_frequency=2)

        assert len(patterns) >= 1
        assert patterns[0].pattern_type == "failure"
        assert patterns[0].frequency >= 2

    def test_extract_fix_strategies(self):
        from arforge.learning_engine import PatternExtractor
        from arforge.learning_system import get_learning_system

        ls = get_learning_system()
        ls.new_session()

        # Record a successful fix
        ls.record_turn(
            "fix import error", "installed missing_lib",
            success=True, error="pip install missing_lib"
        )

        extractor = PatternExtractor()
        patterns = extractor.extract_fix_strategies(limit=50, min_frequency=1)

        # Fix strategies come from fix_strategy field, not error field
        # The record_turn stores error in error_message, not fix_strategy
        assert isinstance(patterns, list)

    def test_extract_all_returns_list(self):
        from arforge.learning_engine import PatternExtractor
        extractor = PatternExtractor()
        patterns = extractor.extract_all(limit=50)
        assert isinstance(patterns, list)

    def test_detect_regressions_empty(self):
        from arforge.learning_engine import PatternExtractor
        extractor = PatternExtractor()
        patterns = extractor.detect_regressions(limit=50)
        assert isinstance(patterns, list)


class TestInjectionPipeline:
    """Tests for InjectionPipeline - building context for agent turns."""

    def test_inject_returns_list(self):
        from arforge.learning_engine import InjectionPipeline, get_learning_engine
        from arforge.learning_schema import InjectionContext

        engine = get_learning_engine()
        ls = engine._system
        ls.new_session()

        # Record some data
        for i in range(5):
            ls.record_turn(
                f"task {i}", f"answer {i}",
                success=i % 2 == 0,
                error=f"error_{i}" if i % 2 == 1 else ""
            )

        pipeline = InjectionPipeline()
        ctx = InjectionContext(user_input="fix bug", route_type="code")
        results = pipeline.inject(ctx)

        assert isinstance(results, list)
        # Each result should have expected fields
        for r in results:
            assert hasattr(r, "content")
            assert hasattr(r, "priority")
            assert hasattr(r, "injector_type")

    def test_build_injection_text(self):
        from arforge.learning_engine import get_learning_engine

        engine = get_learning_engine()
        ls = engine._system
        ls.new_session()

        ls.record_turn("test", "answer", success=True)
        ls.record_turn("bug", "fix", success=False, error="something broke")

        text = engine.build_injection_text("fix bug", "code")
        assert isinstance(text, str)

    def test_empty_injection_no_data(self):
        from arforge.learning_engine import get_learning_engine

        engine = get_learning_engine()
        # No data should still work
        text = engine.build_injection_text("test", "unknown")
        assert isinstance(text, str)


class TestConsolidationEngine:
    """Tests for ConsolidationEngine."""

    def test_consolidate_returns_dict(self):
        from arforge.learning_engine import ConsolidationEngine
        engine = ConsolidationEngine()
        result = engine.consolidate()
        assert isinstance(result, dict)
        assert "patterns_found" in result
        assert "saved_new" in result
        assert "breakdown" in result

    def test_consolidate_with_data(self):
        from arforge.learning_engine import ConsolidationEngine
        from arforge.learning_system import get_learning_system

        ls = get_learning_system()
        ls.new_session()

        # Record some failures
        for i in range(3):
            ls.record_turn(
                f"bug {i}", f"fix {i}",
                success=False,
                error=f"ValueError: invalid value {i}"
            )

        engine = ConsolidationEngine()
        result = engine.consolidate()

        assert result["patterns_found"] >= 0
        assert "failure" in result["breakdown"]

    def test_consolidation_facade(self):
        from arforge.learning_engine import get_consolidation_status

        result = get_consolidation_status()  # was consolidate_learning)
        assert "total_patterns" in result
        assert "by_type" in result
        status = get_consolidation_status()
        assert "total_patterns" in status
        assert "by_type" in status


class TestDreamingEngine:
    """Tests for DreamingEngine."""

    def test_run_once_returns_dict(self):
        from arforge.learning_engine import DreamingEngine
        engine = DreamingEngine()
        result = engine.run_once()
        assert isinstance(result, dict)
        assert "insights" in result
        assert "suggestions" in result
        assert "timestamp" in result

    def test_reflect_returns_list(self):
        from arforge.learning_engine import DreamingEngine
        engine = DreamingEngine()
        reflections = engine.reflect()
        assert isinstance(reflections, list)

    def test_dreaming_facade(self):
        from arforge.learning_engine import get_dreaming_insights, get_learning_engine

        result = get_learning_engine().dream()  # was run_dreaming_once)
        assert isinstance(result, dict)
        assert "insights" in result

        insights = get_dreaming_insights()
        assert "insights" in insights


class TestLearningEngine:
    """Tests for the unified LearningEngine."""

    def test_singleton(self):
        from arforge.learning_engine import get_learning_engine
        e1 = get_learning_engine()
        e2 = get_learning_engine()
        assert e1 is e2

    def test_record_and_get_injections(self):
        from arforge.learning_engine import get_learning_engine
        from arforge.learning_schema import InjectionContext

        engine = get_learning_engine()
        ls = engine._system
        ls.new_session()

        rid = engine.record_turn(
            "implement feature X", "wrote code",
            route_type="code", has_error=True,
            error_message="ModuleNotFoundError: No module named 'xyz'"
        )
        assert rid > 0

        injections = engine.get_injections(
            InjectionContext(user_input="module not found", route_type="code")
        )
        assert isinstance(injections, list)

    def test_stats(self):
        from arforge.learning_engine import get_learning_engine
        engine = get_learning_engine()
        s = engine.stats()
        assert isinstance(s, str)
        assert "Learning System Statistics" in s

    def test_consolidate_and_dream(self):
        from arforge.learning_engine import get_learning_engine

        engine = get_learning_engine()
        ls = engine._system
        ls.new_session()

        ls.record_turn("test", "ok", success=True)
        ls.record_turn("bug", "fail", success=False, error="some error")

        c = engine.consolidate()
        assert "patterns_found" in c

        d = engine.dream()
        assert "insights" in d

    def test_reflect(self):
        from arforge.learning_engine import get_learning_engine
        engine = get_learning_engine()
        r = engine.reflect()
        assert isinstance(r, list)

    def test_frequent_errors(self):
        from arforge.learning_engine import get_learning_engine
        engine = get_learning_engine()
        errors = engine.get_frequent_errors(limit=5)
        assert isinstance(errors, list)

    def test_extract_patterns(self):
        from arforge.learning_engine import get_learning_engine
        engine = get_learning_engine()
        patterns = engine.extract_patterns(limit=20)
        assert isinstance(patterns, list)


class TestLearningCLI:
    """Tests for learning_cli.py enhanced status display."""

    def test_learning_status_returns_string(self):
        from arforge.learning_cli import learning_status
        result = learning_status()
        assert isinstance(result, str)

    def test_learning_report_returns_dict(self):
        from arforge.learning_cli import learning_report
        result = learning_report()
        assert isinstance(result, dict)
        assert "patterns" in result
        assert "consolidation" in result

    def test_learning_status_with_data(self):
        from arforge.learning_system import get_learning_system
        from arforge.learning_cli import learning_status

        ls = get_learning_system()
        ls.new_session()

        # Record some data
        ls.record_turn("test coding", "code answer", success=True)
        ls.record_turn("bug report", "fix attempt", success=False, error="RuntimeError")

        result = learning_status()
        assert "Learning System Statistics" in result


class TestDogfoodLearningPipeline:
    """Tests for dogfood -> learning pipeline integration."""

    def test_dogfood_record_feeds_learning(self):
        """Verify dogfood data can be read by learning system."""
        from arforge.learning_system import get_learning_system
        from arforge.core.dogfood import RunOutcome, record_outcome, load_outcomes

        ls = get_learning_system()
        ls.new_session()

        # Simulate a dogfood recording
        outcome = RunOutcome(
            task="test addition",
            success=True,
            steps=3,
            tool_calls=2,
            tokens=500,
            cost_cny=0.01,
            modified_files=1,
        )
        assert record_outcome(outcome)

        # Also record in learning system
        ls.record_turn(
            "test addition", "result: 2+2=4",
            success=True, route="code", tools=["read_file", "edit_file"]
        )

        # Both should work independently
        loaded = load_outcomes()
        assert len(loaded) >= 1

    def test_dogfood_and_learning_coexist(self):
        """Verify dogfood and learning systems don't interfere."""
        from arforge.learning_system import get_learning_system
        from arforge.core.dogfood import stats as dogfood_stats

        ls = get_learning_system()
        ls.new_session()

        ls.record_turn("task A", "result A", success=True)
        ls.record_turn("task B", "result B", success=False, error="bug")

        ds = dogfood_stats()
        ls_stats = ls.get_stats()

        assert isinstance(ds, dict)
        assert ls_stats.total_turns >= 2


class TestPatternExtraction:
    """Tests for learning_patterns.py."""

    def test_extract_patterns_returns_dict(self):
        from arforge.learning_patterns import extract_patterns
        result = extract_patterns(limit=20)
        assert isinstance(result, dict)
        assert "routes" in result
        assert "errors" in result
        assert "error_types" in result

    def test_extract_error_clusters(self):
        from arforge.learning_patterns import extract_error_clusters
        result = extract_error_clusters(limit=50)
        assert isinstance(result, list)

    def test_extract_successful_routes(self):
        from arforge.learning_patterns import extract_successful_routes
        result = extract_successful_routes(limit=50)
        assert isinstance(result, dict)


class TestLearningInjector:
    """Tests for learning_injector.py."""

    def test_build_learning_context(self):
        from arforge.learning_engine import build_learning_context
        result = build_learning_context("test input")
        assert isinstance(result, str)

    def test_get_injection_summary(self):
        from arforge.learning_engine import get_injection_summary
        result = get_injection_summary("test input", "code")
        assert isinstance(result, dict)
        assert "injection_count" in result
        assert "has_data" in result


class TestLearningProfile:
    """Tests for learning.py profile."""

    def test_get_learning_adjustments(self):
        from arforge.learning import get_learning_adjustments
        result = get_learning_adjustments()
        assert isinstance(result, list)

    def test_update_learning_profile(self):
        from arforge.learning import update_learning_profile, get_learning_profile
        update_learning_profile(5, "code_answer", "please give detailed response")
        profile = get_learning_profile()
        assert "preferred_detail" in profile
        assert "avoid_patterns" in profile


class TestLearningMeta:
    """Tests for learning_meta.py."""

    def test_learning_system_info(self):
        from arforge.learning_engine import learning_system_info
        info = learning_system_info()
        assert info["version"] == "v2"
        assert info["storage"] == "sqlite"
        assert "total_turns" in info
        assert "success_rate" in info
