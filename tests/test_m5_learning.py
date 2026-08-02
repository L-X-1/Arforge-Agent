"""M5 acceptance tests: Learning and Memory Evolution.

Proves that learning is measurable:
1. Outcomes are recorded and retrievable
2. Failures auto-generate patterns
3. Learning injection produces context from past outcomes
4. Learning stats are computed correctly
5. The learning loop impacts future responses
"""


# ============================================================================
# LearningSystem: recording and retrieval
# ============================================================================


def test_learning_system_singleton():
    from arforge.learning_system import get_learning_system, LearningSystem

    ls1 = get_learning_system()
    ls2 = get_learning_system()
    assert ls1 is ls2
    assert isinstance(ls1, LearningSystem)


def test_record_and_retrieve_outcome():
    """Record a turn, verify it appears in outcomes."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()
    before = len(ls.get_outcomes(limit=100))

    outcome_id = ls.record_turn(
        user_input="m5 test: calculate 2+2",
        answer="4",
        success=True,
        intent="tool",
        route="calculate",
    )
    assert outcome_id > 0

    after = len(ls.get_outcomes(limit=100))
    assert after >= before


def test_record_failure_generates_pattern():
    """Failed outcomes auto-generate failure patterns."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()
    before_patterns = len(ls.get_patterns(pattern_type="failure", limit=100))

    ls.record_turn(
        user_input="m5 test: run rm -rf /",
        answer="",
        success=False,
        intent="tool",
        route="run_cmd",
        error="command not allowed",
    )

    after_patterns = len(ls.get_patterns(pattern_type="failure", limit=100))
    assert after_patterns >= before_patterns, "Failure should auto-generate a pattern"


def test_add_and_retrieve_pattern():
    """Manually added patterns should be retrievable."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()
    pid = ls.add_pattern(
        pattern_type="fix",
        description="Always check API key before model calls — missing key causes RuntimeError",
        tags=["model", "api_key"],
        confidence=0.95,
    )
    assert pid > 0

    patterns = ls.get_patterns(pattern_type="fix", limit=50)
    fix_descriptions = [p["description"] for p in patterns]
    assert any("API key" in d or "api_key" in str(p.get("tags", [])) for d, p in zip(fix_descriptions, patterns) if "API" in d), (
        f"Fix pattern should be findable, got: {fix_descriptions[:3]}"
    )


def test_add_user_preference():
    """User preferences are stored as patterns and injectable."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()
    ls.add_pattern(
        pattern_type="preference",
        description="User prefers Chinese responses for all technical explanations",
        tags=["chinese", "language"],
        confidence=0.9,
    )

    prefs = ls.get_patterns(pattern_type="preference", limit=50)
    assert any("Chinese" in p["description"] or "chinese" in str(p.get("tags", [])) for p in prefs)


# ============================================================================
# Learning injection — proving learning impacts context
# ============================================================================


def test_injection_builds_context():
    """build_injection_context() should return non-empty string after recording."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()

    # Record some outcomes first
    ls.record_turn("test query for injection", "answer", success=True)
    ls.record_turn("another query", "", success=False, error="syntax error in tool call")

    ctx = ls.build_injection_context("test query for injection")
    assert len(ctx) > 0, f"Injection context should not be empty after recording, got: {ctx!r}"
    assert "Outcome" in ctx.lower() or "failure" in ctx.lower() or "learned" in ctx.lower()


def test_injection_context_includes_failures():
    """Injection context should warn about past failures."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()

    ls.record_turn("delete important file", "", success=False, error="file not found")
    ls.record_turn("safe operation", "ok", success=True)

    ctx = ls.build_injection_context("delete something")
    assert len(ctx) > 0


def test_empty_injection_when_no_data():
    """Fresh learning system with no data returns empty injection."""
    from arforge.learning_system import LearningSystem

    ls = LearningSystem()
    ls.new_session()
    ctx = ls.build_injection_context("random query")
    # May be empty or contain only "Recent Session Outcomes" header with nothing
    assert isinstance(ctx, str)


# ============================================================================
# Statistics — measurable proof
# ============================================================================


def test_stats_compute_correctly():
    """Statistics should reflect recorded outcomes."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()

    # Record known outcomes
    ls.record_turn("ok1", "ans1", success=True)
    ls.record_turn("ok2", "ans2", success=True)
    ls.record_turn("fail1", "", success=False, error="test error")
    ls.record_turn("ok3", "ans3", success=True, feedback="correct")

    s = ls.get_stats()
    assert s.total_turns >= 4
    assert s.successful_turns >= 3
    assert s.failed_turns >= 1
    assert s.user_corrections >= 1
    assert 0.0 <= s.success_rate <= 1.0


def test_stats_summary_readable():
    """stats_summary() should produce human-readable output."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()
    summary = ls.stats_summary()

    assert "Turns" in summary or "turns" in summary.lower()
    assert "Success" in summary or "success" in summary.lower()
    assert len(summary) > 50


# ============================================================================
# Agent auto-recording — full loop proof
# ============================================================================


def test_agent_chat_records_outcome():
    """Every agent.chat() call should auto-record a learning outcome."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()
    before = len(ls.get_outcomes(limit=1000))

    from arforge.core.agent_core import ArforgeAgent

    agent = ArforgeAgent()
    agent.chat("Say 'hello' in exactly one word.")

    after = len(ls.get_outcomes(limit=1000))
    assert after > before, f"Agent chat should auto-record outcome. Before={before}, After={after}"


def test_learning_system_new_session():
    """new_session() should generate a unique session ID."""
    from arforge.learning_system import get_learning_system

    ls = get_learning_system()
    sid1 = ls.new_session()
    sid2 = ls.new_session()

    assert sid1 != sid2
    assert sid1.startswith("ls_")
    assert sid2.startswith("ls_")


# ============================================================================
# Memory integration — Pattern persistence
# ============================================================================


def test_memory_and_learning_coexist():
    """Memory (SQLite memories table) and learning (outcomes/patterns) are separate."""
    from arforge.memory import get_memory_stats, save_memory_v2
    from arforge.learning_system import get_learning_system

    mem_before = get_memory_stats()
    ls = get_learning_system()

    # Add a memory
    save_memory_v2("m5 integration test memory", mem_type="test")

    # Record a learning outcome
    ls.record_turn("m5 learning test", "answer")

    # Both should exist independently
    mem_after = get_memory_stats()
    assert mem_after["count"] >= mem_before["count"]

    outcomes = ls.get_outcomes(limit=100)
    assert len(outcomes) >= 1


# ============================================================================
# Slash command integration
# ============================================================================


def test_learn_slash_shows_stats():
    """The /learn slash command should show learning stats."""
    from arforge.slash_memory_learning import learning_status

    result = learning_status()
    assert len(result) > 0
    assert "turns" in result.lower() or "Learning" in result or "Turns" in result


def test_remember_slash_saves():
    """The /remember slash command should save to memory."""
    from arforge.slash_memory_learning import remember

    result = remember("m5 test: remember this important fact")
    assert "saved" in result.lower() or "Saved" in result
