"""Learning CLI helpers - enhanced status and reporting for /learn commands."""

from __future__ import annotations


def learning_status() -> str:
    """Show comprehensive learning system status.

    Includes: stats summary, patterns with confidence, injection impact,
    Ebbinghaus decay, recall quality, bridge stats, dreaming insights,
    and session activity.
    """
    from arforge.learning_engine import get_learning_engine

    engine = get_learning_engine()

    # Basic stats
    lines = [engine.stats()]

    # Pattern breakdown
    try:
        from arforge.database import LearningPattern, get_session

        with get_session() as session:
            patterns = (
                session.query(LearningPattern)
                .order_by(LearningPattern.frequency.desc())
                .limit(10)
                .all()
            )

        if patterns:
            lines.append("")
            lines.append("Learned Patterns:")
            for p in patterns:
                conf_bar = "#" * int(p.confidence * 10)
                lines.append(
                    f"  [{p.pattern_type}] {p.description[:80]} "
                    f"(x{p.frequency}, {p.confidence:.0%} {conf_bar})"
                )
    except Exception:
        pass

    # Injection impact
    try:
        impact = engine.get_injection_impact()
        if impact.status == "measured":
            lines.append("")
            lines.append(
                f"Injection Impact: {impact.uplift:+.1%} uplift "
                f"(injected {impact.injected_success_rate:.0%} vs "
                f"baseline {impact.baseline_success_rate:.0%})"
            )
        else:
            lines.append("")
            lines.append(
                f"Injection Impact: insufficient data "
                f"(injected={impact.injected_turns}, baseline={impact.baseline_turns}, "
                f"need {impact.min_sample} each)"
            )
    except Exception:
        pass

    # Ebbinghaus decay summary
    try:
        from arforge.core.ebbinghaus_overview import get_curve_overview

        decay = get_curve_overview()
        lines.append("")
        lines.append("Ebbinghaus Forgetting Curve:")
        for item in decay.get("retentions", []):
            lines.append(f"  {item['label']:>6}: {item['retention']:.0%} retention")
        lines.append(f"  Review schedule: {decay.get('schedule', 'N/A')}")
    except Exception:
        pass

    # Recall quality (BM25 self-recall)
    try:
        from arforge.semantic_memory import recall_quality_report

        rq = recall_quality_report()
        lines.append("")
        lines.append("Memory Recall Quality (BM25):")
        lines.append(f"  Top-1 Hit Rate: {rq['top1_hit_rate']:.1%}")
        lines.append(f"  MRR: {rq['mrr']:.3f}")
        lines.append(f"  Indexed: {rq['indexed']} | Evaluated: {rq['evaluated']}")
    except Exception:
        pass

    # Dreaming insights
    try:
        dream_result = engine.dream()
        insights = dream_result.get("insights", [])
        suggestions = dream_result.get("suggestions", [])
        if insights:
            lines.append("")
            lines.append("Dreaming Insights:")
            for i in insights[:3]:
                lines.append(f"  - {i}")
        if suggestions:
            lines.append("")
            lines.append("Suggestions:")
            for s in suggestions[:3]:
                lines.append(f"  -> {s}")
    except Exception:
        pass

    # Memory-learning bridge stats
    try:
        from arforge.core.learning_memory_bridge import get_bridge_stats

        bridge = get_bridge_stats()
        lines.append("")
        lines.append("Memory-Learning Bridge:")
        lines.append(f"  Total memories: {bridge['total_memories']}")
        lines.append(f"  High-quality (promotable): {bridge['high_quality_memories']}")
        lines.append(f"  Auto-promoted patterns: {bridge['auto_promoted_patterns']}")
        lines.append(f"  Total learning patterns: {bridge['total_patterns']}")
    except Exception:
        pass

    # Per-category pattern breakdown
    try:
        from arforge.database import LearningPattern, get_session
        from collections import Counter

        with get_session() as session:
            all_patterns = session.query(LearningPattern).all()

        if all_patterns:
            cats = Counter(p.pattern_type for p in all_patterns)
            lines.append("")
            lines.append("Patterns by Category:")
            for cat, count in cats.most_common():
                pct = count / len(all_patterns) * 100
                bar = "#" * min(20, int(pct / 5))
                lines.append(f"  {cat:<15} {count:>3} ({pct:5.1f}%) {bar}")
    except Exception:
        pass

    # Session summary
    try:
        from arforge.database import LearningOutcome, get_session

        with get_session() as session:
            total = session.query(LearningOutcome).count() or 0
            successes = (
                session.query(LearningOutcome)
                .filter(LearningOutcome.success == 1)
                .count()
                or 0
            )
            failures = total - successes
            with_injection = (
                session.query(LearningOutcome)
                .filter(LearningOutcome.injected_context_size > 0)
                .count()
                or 0
            )

        lines.append("")
        lines.append("Session Activity:")
        lines.append(f"  Total turns: {total}")
        lines.append(f"  Successes:   {successes}")
        lines.append(f"  Failures:    {failures}")
        if total > 0:
            lines.append(f"  Success rate: {successes / total:.0%}")
            lines.append(
                f"  With injection: {with_injection}/{total} "
                f"({with_injection / total:.0%})"
            )
    except Exception:
        pass

    return "\n".join(lines)


def learning_reflect(use_llm: bool = False) -> str:
    """3.2: Run reflection on learning outcomes.

    Without --llm: statistical analysis of success/failure rates.
    With --llm: feed recent failures to the LLM for root-cause analysis
    and pattern drafting.
    """
    from arforge.learning_engine import reflect_recent
    import config

    llm_enabled = use_llm or getattr(config, "LLM_REFLECT_ENABLED", False)
    reflections = reflect_recent(use_llm=llm_enabled)

    lines = ["Learning Reflection", "=" * 30]
    if llm_enabled:
        lines.append("Mode: LLM-driven deep reflection")
    else:
        lines.append("Mode: Statistical analysis (use --llm for deep reflection)")

    lines.append("")
    for i, r in enumerate(reflections, 1):
        lines.append(f"  {i}. {r}")

    return "\n".join(lines)


def learning_report() -> dict:
    """Get a structured learning report."""
    from arforge.learning_engine import get_learning_engine
    from arforge.learning_patterns import extract_patterns
    from arforge.learning_engine import get_consolidation_status

    engine = get_learning_engine()

    return {
        "stats": engine.get_stats(),
        "patterns": extract_patterns(100),
        "consolidation": get_consolidation_status(),
        "injection_impact": engine.get_injection_impact(),
    }
