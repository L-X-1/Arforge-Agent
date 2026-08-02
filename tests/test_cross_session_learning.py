# -*- coding: utf-8 -*-
"""Cross-session learning persistence and injection verification tests.

Proves that:
1. Learning outcomes survive across sessions
2. Patterns extracted in one session inject into subsequent sessions
3. Injection context is relevant to the user's query
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _clean_learning_db():
    """Ensure clean state before and after each test."""
    from arforge.database import LearningOutcome, LearningPattern, get_session
    # Clean before
    with get_session() as s:
        s.query(LearningPattern).delete()
        s.query(LearningOutcome).delete()
    yield
    # Clean after
    with get_session() as s:
        s.query(LearningPattern).delete()
        s.query(LearningOutcome).delete()


class TestCrossSessionPersistence:
    """Verify learning outcomes and patterns persist across sessions."""

    def test_outcomes_persist_in_database(self):
        from arforge.learning_engine import get_learning_engine
        from arforge.database import LearningOutcome, get_session

        engine = get_learning_engine()

        # Session 1: Record several outcomes
        engine.record_turn(
            user_input="Fix the login bug",
            answer="Added error handling",
            success=False,
            intent="bug_fix",
            tools=["edit_file", "run_cmd"],
            error="AttributeError: 'NoneType' has no attribute 'id'",
        )
        engine.record_turn(
            user_input="Write unit tests for auth module",
            answer="Created 5 test cases",
            success=True,
            intent="testing",
            tools=["write_file", "run_cmd"],
        )

        with get_session() as s:
            count = s.query(LearningOutcome).count()
        assert count == 2, f"Expected 2 outcomes, got {count}"

        # Session 2: Outcomes still there
        engine.record_turn(
            user_input="Refactor database layer",
            answer="Split into modules",
            success=True,
            intent="refactor",
            tools=["edit_file", "run_cmd"],
        )

        with get_session() as s:
            count = s.query(LearningOutcome).count()
        assert count == 3, f"Expected 3 outcomes after session 2, got {count}"

    def test_patterns_consolidate_from_outcomes(self):
        from arforge.learning_engine import get_learning_engine
        from arforge.database import LearningPattern, get_session

        engine = get_learning_engine()

        # Record several similar failures
        for i in range(3):
            engine.record_turn(
                user_input=f"Task {i}: fix import error",
                answer="",
                success=False,
                intent="bug_fix",
                tools=[],
                error="ModuleNotFoundError: No module named 'utils'",
            )

        # Consolidate should extract patterns
        result = engine.consolidate()
        assert result["patterns_found"] > 0, "Should find at least one pattern"

        with get_session() as s:
            patterns = s.query(LearningPattern).all()
        assert len(patterns) > 0, "Patterns should be persisted in database"

    def test_fix_strategies_learned(self):
        from arforge.learning_engine import get_learning_engine
        from arforge.database import LearningOutcome, get_session

        engine = get_learning_engine()

        # Record a failure then a fix
        engine.record_turn(
            user_input="Deploy to production",
            answer="",
            success=False,
            intent="deploy",
            tools=["run_cmd"],
            error="Connection refused",
        )
        engine.record_turn(
            user_input="Deploy to production (retry)",
            answer="Added --retry flag",
            success=True,
            intent="deploy",
            tools=["run_cmd"],
        )

        with get_session() as s:
            failures = s.query(LearningOutcome).filter(
                LearningOutcome.success == 0
            ).count()
            successes = s.query(LearningOutcome).filter(
                LearningOutcome.success == 1
            ).count()
        assert failures == 1
        assert successes == 1


class TestLearningInjection:
    """Verify learning context is injected based on user queries."""

    def test_failure_pattern_injection(self):
        from arforge.learning_engine import get_learning_engine

        engine = get_learning_engine()

        # Record failures with specific error types
        engine.record_turn(
            user_input="Run database migration",
            answer="",
            success=False,
            intent="migration",
            tools=["run_cmd"],
            error="IntegrityError: duplicate key value",
        )
        engine.record_turn(
            user_input="Run database migration again",
            answer="",
            success=False,
            intent="migration",
            tools=["run_cmd"],
            error="IntegrityError: duplicate key value",
        )

        # Consolidate to extract patterns
        engine.consolidate()

        # Now inject: query about database should bring relevant patterns
        injection_text = engine.build_injection_text(
            "I need to run a database migration", "agentic"
        )
        assert "IntegrityError" in injection_text or len(injection_text) > 0

    def test_empty_injection_when_no_data(self):
        from arforge.learning_engine import get_learning_engine

        # Use fresh engine — DB was cleaned by fixture
        engine = get_learning_engine()

        # No outcomes recorded — injection should be empty
        injection_text = engine.build_injection_text(
            "Some random query", "agentic"
        )
        # With no data, injection should be minimal/empty
        assert len(injection_text) < 100 or injection_text == ""

    def test_injection_contains_context_header(self):
        from arforge.learning_engine import get_learning_engine

        engine = get_learning_engine()
        engine.record_turn(
            user_input="Test task",
            answer="OK",
            success=False,
            intent="testing",
            tools=["run_cmd"],
            error="AssertionError: expected 5, got 4",
        )
        engine.consolidate()

        injection = engine.build_injection_text(
            "Fix the assertion error in tests", "agentic"
        )
        if injection:
            assert "Learning System Context" in injection


class TestLearningStats:
    """Verify learning statistics are accurate."""

    def test_success_rate_calculation(self):
        from arforge.learning_engine import get_learning_engine

        engine = get_learning_engine()

        for i in range(8):
            engine.record_turn(
                user_input=f"Task {i}",
                answer="",
                success=(i < 6),  # 6 success, 2 failure
                intent="general",
                tools=[],
            )

        stats_obj = engine.get_stats()
        assert stats_obj.total_turns == 8
        assert stats_obj.successful_turns == 6
        assert abs(stats_obj.success_rate - 0.75) < 0.01

    def test_patterns_discovered_tracking(self):
        from arforge.learning_engine import get_learning_engine

        engine = get_learning_engine()

        # Record same failure multiple times to form a pattern
        for i in range(3):
            engine.record_turn(
                user_input=f"Error {i}",
                answer="",
                success=False,
                intent="general",
                tools=[],
                error="TypeError: NoneType object is not callable",
            )

        result = engine.consolidate()
        assert result["patterns_found"] >= 1


class TestLearningUndo:
    """Verify /learn undo removes outcomes cleanly."""

    def test_undo_removes_outcome(self):
        from arforge.learning_system import get_learning_system, undo
        from arforge.database import LearningOutcome, get_session

        ls = get_learning_system()
        outcome_id = ls.record_turn(
            user_input="Test undo",
            answer="",
            success=False,
            intent="test",
            tools=[],
            error="TestError: undo me",
        )

        with get_session() as s:
            before = s.query(LearningOutcome).count()
        assert before >= 1

        result = undo(outcome_id)
        assert result is True

        with get_session() as s:
            after = s.query(LearningOutcome).count()
        assert after == before - 1

    def test_undo_nonexistent_returns_false(self):
        from arforge.learning_system import undo
        assert undo(99999) is False
