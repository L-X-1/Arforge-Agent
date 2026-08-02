"""Test A1: Learning injection loop — injection_total from hardcoded 0 to real counting.

Verifies that:
- record_turn() accepts and stores injected_context_size
- get_stats() reports injection_total > 0 after turns with learning context
- injections_per_turn is correctly calculated
- Schema creation works on fresh databases
- Outcome dataclass has injected_context_size field
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, inspect as sa_inspect
from sqlalchemy.orm import sessionmaker

from arforge.database.base import Base
from arforge.learning_system import LearningSystem, Outcome


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def fresh_db(monkeypatch, tmp_path):
    """Create a temporary SQLite database for isolated testing."""
    db_url = f"sqlite:///{tmp_path / 'test_learning.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", db_url)

    engine = create_engine(db_url)
    Base.metadata.create_all(bind=engine)

    # Make sure LearningSystem uses the test DB
    from arforge.database.engine import dispose_engines
    dispose_engines()

    monkeypatch.setattr("arforge.database.engine._engine", engine)
    monkeypatch.setattr("arforge.database.engine._SessionLocal", sessionmaker(bind=engine, expire_on_commit=False))

    yield db_url

    dispose_engines()
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def learning(fresh_db):
    """Create a fresh LearningSystem instance."""
    # Reset global singleton to pick up new DB
    import arforge.learning_system as ls_module
    old = ls_module._LEARNING
    ls_module._LEARNING = None
    ls = LearningSystem()
    yield ls
    ls_module._LEARNING = old


# ---------------------------------------------------------------------------
# Test 1: record_turn accepts and stores injected_context_size
# ---------------------------------------------------------------------------


def test_record_turn_with_injection_context_size(learning):
    """record_turn() should accept and store injected_context_size."""
    learning.record_turn(
        user_input="hello",
        answer="hi there",
        success=True,
        injected_context_size=5,
    )
    outcomes = learning.get_outcomes(limit=1)
    assert len(outcomes) == 1
    assert outcomes[0].injected_context_size == 5


# ---------------------------------------------------------------------------
# Test 2: get_stats reports injection_total > 0 after injected turns
# ---------------------------------------------------------------------------


def test_injection_total_increases_with_injected_turns(learning):
    """After turns with injected_context_size > 0, injection_total should be > 0."""
    # Record turns without injection
    for i in range(2):
        learning.record_turn(
            user_input=f"turn {i}",
            answer=f"answer {i}",
            injected_context_size=0,
        )

    # Record turns with injection
    for i in range(3):
        learning.record_turn(
            user_input=f"turn with injection {i}",
            answer=f"answer {i}",
            injected_context_size=42,
        )

    stats = learning.get_stats()
    assert stats.total_turns == 5
    assert stats.injections_per_turn > 0, f"Expected injections_per_turn > 0, got {stats.injections_per_turn}"
    assert stats.injections_per_turn == pytest.approx(3 / 5, 0.01)


# ---------------------------------------------------------------------------
# Test 3: Zero injected_context_size yields zero injections_per_turn
# ---------------------------------------------------------------------------


def test_no_injections_when_all_zero(learning):
    """When all turns have injected_context_size=0, injections_per_turn should be 0."""
    for i in range(5):
        learning.record_turn(
            user_input=f"turn {i}",
            answer=f"answer {i}",
            injected_context_size=0,
        )
    stats = learning.get_stats()
    assert stats.total_turns == 5
    assert stats.injections_per_turn == 0.0


# ---------------------------------------------------------------------------
# Test 4: stats_summary includes injection data
# ---------------------------------------------------------------------------


def test_stats_summary_no_error(learning):
    """stats_summary() should not crash and should produce output."""
    learning.record_turn(
        user_input="test input",
        answer="test answer",
        injected_context_size=10,
    )
    summary = learning.stats_summary()
    assert "Learning System Statistics" in summary
    assert "Turns recorded" in summary


# ---------------------------------------------------------------------------
# Test 5: Outcome dataclass has injected_context_size field
# ---------------------------------------------------------------------------


def test_outcome_dataclass_has_injected_context_size():
    """Outcome dataclass should have injected_context_size with default 0."""
    o = Outcome()
    assert hasattr(o, "injected_context_size")
    assert o.injected_context_size == 0

    o2 = Outcome(injected_context_size=7)
    assert o2.injected_context_size == 7


# ---------------------------------------------------------------------------
# Test 6: Schema creation on fresh DB includes all columns
# ---------------------------------------------------------------------------


def test_schema_creation_includes_injected_context_size(monkeypatch, tmp_path):
    """Creating tables on a fresh DB should include injected_context_size column."""
    db_url = f"sqlite:///{tmp_path / 'test_schema.db'}"
    monkeypatch.setenv("ARFORGE_DB_URL", db_url)

    engine = create_engine(db_url)
    Base.metadata.create_all(bind=engine)

    insp = sa_inspect(engine)
    cols = {c["name"] for c in insp.get_columns("learning_outcomes")}
    assert "injected_context_size" in cols


# ---------------------------------------------------------------------------
# Test 7: record_turn default value preserves backward compat
# ---------------------------------------------------------------------------


def test_record_turn_default_injected_context_size(learning):
    """record_turn() without injected_context_size should default to 0 (backward compat)."""
    learning.record_turn(
        user_input="no injection arg",
        answer="answer",
    )
    outcomes = learning.get_outcomes(limit=1)
    assert outcomes[0].injected_context_size == 0
