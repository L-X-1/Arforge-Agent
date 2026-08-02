"""Unified learning system — record, retrieve, and inject learning experiences.

Core principle: every turn outcome is recorded; past learnings are injected into
future conversations to improve quality.  All learning is measurable.

Pipeline:
  turn → record_outcome() → success/failure/fix/regression stored
  next_turn → inject_learnings() → relevant patterns added to context
  evaluate → measure injection impact on answer quality
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import case, func

from arforge.database import LearningOutcome, LearningPattern, get_session


# ====================================================================
# Schema — structured learning records
# ====================================================================


@dataclass
class Outcome:
    """A single turn outcome — what happened and what was learned."""

    outcome_id: int = 0
    session_id: str = ""
    turn_index: int = 0
    timestamp: str = ""
    user_input: str = ""
    intent: str = "general"
    route: str = "unknown"
    tools_used: list[str] = field(default_factory=list)
    model_answer: str = ""
    success: bool = True
    error_type: str = ""
    error_message: str = ""
    user_feedback: str = ""  # "correct" / "incorrect" / "helpful" / "unhelpful" / ""
    fix_strategy: str = ""
    regression: bool = False
    tokens_used: int = 0
    response_time_ms: float = 0.0
    tags: list[str] = field(default_factory=list)
    importance: float = 0.0
    injected_context_size: int = 0


@dataclass
class Pattern:
    """A learned pattern — extracted from outcomes over time."""

    pattern_id: int = 0
    pattern_type: str = ""  # "success" / "failure" / "fix" / "preference" / "convention"
    description: str = ""
    frequency: int = 1
    last_seen: str = ""
    confidence: float = 0.5
    source_turns: list[int] = field(default_factory=list)
    related_tags: list[str] = field(default_factory=list)


@dataclass
class LearningStats:
    """Aggregated learning statistics — measurable proof of learning."""

    total_turns: int = 0
    successful_turns: int = 0
    failed_turns: int = 0
    success_rate: float = 0.0
    patterns_discovered: int = 0
    fix_strategies_learned: int = 0
    regressions_caught: int = 0
    user_corrections: int = 0
    injections_per_turn: float = 0.0
    top_tags: list[str] = field(default_factory=list)
    recent_learnings: list[dict] = field(default_factory=list)


@dataclass
class InjectionImpact:
    """Observed injected-vs-baseline outcome comparison."""

    injected_turns: int = 0
    injected_successes: int = 0
    injected_success_rate: float = 0.0
    baseline_turns: int = 0
    baseline_successes: int = 0
    baseline_success_rate: float = 0.0
    uplift: float = 0.0
    status: str = "insufficient_data"
    min_sample: int = 3


# ====================================================================
# LearningSystem
# ====================================================================


class LearningSystem:
    """Records, retrieves, and injects learning experiences."""

    def __init__(self):
        import random

        self._session_id = datetime.now().strftime("ls_%Y%m%d_%H%M%S") + f"_{random.randint(1000, 9999)}"
        self._turn_index = 0

    # -- session management --------------------------------------------------

    def new_session(self):
        import random

        self._session_id = datetime.now().strftime("ls_%Y%m%d_%H%M%S") + f"_{random.randint(1000, 9999)}"
        self._turn_index = 0
        return self._session_id

    # -- recording -----------------------------------------------------------

    def record_outcome(self, outcome: Outcome) -> int:
        """Record a turn outcome. Returns the row id."""
        now = datetime.now().isoformat(timespec="seconds")
        with get_session() as session:
            lo = LearningOutcome(
                created_at=now,
                session_id=outcome.session_id or self._session_id,
                turn_index=outcome.turn_index or self._turn_index,
                user_input=outcome.user_input[:500],
                intent=outcome.intent,
                route=outcome.route,
                tools_used=json.dumps(outcome.tools_used, ensure_ascii=False),
                success=int(outcome.success),
                error_type=outcome.error_type,
                error_message=outcome.error_message[:500],
                user_feedback=outcome.user_feedback,
                fix_strategy=outcome.fix_strategy,
                regression=int(outcome.regression),
                tokens_used=outcome.tokens_used,
                response_time_ms=outcome.response_time_ms,
                tags=json.dumps(outcome.tags, ensure_ascii=False),
                importance=outcome.importance,
                injected_context_size=outcome.injected_context_size,
            )
            session.add(lo)
            session.flush()
            row_id = int(lo.id)
        self._turn_index += 1
        # Auto-detect patterns from failures
        if not outcome.success:
            self._maybe_extract_pattern(outcome)
        return row_id

    def record_turn(
        self,
        user_input: str,
        answer: str = "",
        success: bool = True,
        intent: str = "general",
        route: str = "unknown",
        tools: list[str] | None = None,
        error: str = "",
        error_type: str = "",
        feedback: str = "",
        injected_context_size: int = 0,
    ) -> int:
        """Convenience: record a turn with minimal boilerplate."""
        return self.record_outcome(
            Outcome(
                session_id=self._session_id,
                turn_index=self._turn_index,
                timestamp=datetime.now().isoformat(timespec="seconds"),
                user_input=user_input,
                model_answer=answer[:200],
                success=success,
                intent=intent,
                route=route,
                tools_used=tools or [],
                error_message=error,
                error_type=error_type,
                user_feedback=feedback,
                injected_context_size=injected_context_size,
            )
        )

    def record_failure_pattern(
        self,
        error_message: str,
        user_input: str = "",
        source: str = "self_correct",
        confidence: float = 0.8,
    ) -> int | None:
        """3.4: Record a failure pattern directly (used by hopeless abort).

        Writes a failure-type LearningPattern with elevated confidence
        since this comes from a programmatic abort decision.
        """
        description = error_message[:200]
        if user_input:
            description = f"[{user_input[:80]}] {description}"

        # Check for existing similar pattern to avoid duplicates
        existing = self.get_patterns(pattern_type="failure", limit=20)
        for p in existing:
            if error_message[:60] in p.get("description", ""):
                return None  # already exists

        return self.add_pattern(
            pattern_type="failure",
            description=description,
            tags=[source, "hopeless", "auto-generated"],
            confidence=confidence,
        )

    # -- pattern extraction --------------------------------------------------

    def _maybe_extract_pattern(self, outcome: Outcome) -> None:
        """Auto-extract a pattern from a failed outcome."""
        if not outcome.error_message:
            return
        existing = self.get_patterns(pattern_type="failure", limit=50)
        for p in existing:
            if outcome.error_message[:80] in p["description"]:
                # Update existing pattern
                self._inc_pattern(p["id"])
                return
        # New pattern
        self.add_pattern(
            pattern_type="failure",
            description=_failure_pattern_description(outcome.error_message, outcome.user_input),
            tags=[outcome.error_type] if outcome.error_type else [],
        )

    def _inc_pattern(self, pattern_id: int):
        now = datetime.now().isoformat(timespec="seconds")
        with get_session() as session:
            session.query(LearningPattern).filter(LearningPattern.id == pattern_id).update(
                {LearningPattern.frequency: LearningPattern.frequency + 1, LearningPattern.updated_at: now},
                synchronize_session="fetch",
            )

    # -- patterns ------------------------------------------------------------

    def add_pattern(self, pattern_type: str, description: str, tags: list[str] | None = None, confidence: float = 0.5) -> int:
        """Add a learned pattern."""
        now = datetime.now().isoformat(timespec="seconds")
        with get_session() as session:
            lp = LearningPattern(
                created_at=now,
                updated_at=now,
                pattern_type=pattern_type,
                description=description,
                frequency=1,
                confidence=confidence,
                tags=json.dumps(tags or [], ensure_ascii=False),
            )
            session.add(lp)
            session.flush()
            return int(lp.id)

    def get_patterns(self, pattern_type: str = "", limit: int = 20) -> list[dict]:
        """Retrieve learned patterns, optionally filtered by type."""
        with get_session() as session:
            q = session.query(LearningPattern)
            if pattern_type:
                q = q.filter(LearningPattern.pattern_type == pattern_type)
            rows = q.order_by(LearningPattern.frequency.desc(), LearningPattern.id.desc()).limit(limit).all()
        return [
            {
                "id": r.id,
                "created_at": r.created_at,
                "updated_at": r.updated_at,
                "pattern_type": r.pattern_type,
                "description": r.description,
                "frequency": r.frequency,
                "confidence": r.confidence,
                "tags": json.loads(r.tags) if r.tags else [],
            }
            for r in rows
        ]

    # -- outcomes retrieval --------------------------------------------------

    def get_outcomes(self, limit: int = 20, failed_only: bool = False) -> list[Outcome]:
        """Retrieve recorded outcomes."""
        with get_session() as session:
            q = session.query(LearningOutcome)
            if failed_only:
                q = q.filter(LearningOutcome.success == 0)
            rows = q.order_by(LearningOutcome.id.desc()).limit(limit).all()
        results = []
        for r in rows:
            results.append(
                Outcome(
                    outcome_id=r.id,
                    session_id=r.session_id,
                    turn_index=r.turn_index,
                    user_input=r.user_input,
                    intent=r.intent,
                    route=r.route,
                    tools_used=json.loads(r.tools_used) if r.tools_used else [],
                    success=bool(r.success),
                    error_type=r.error_type,
                    error_message=r.error_message,
                    user_feedback=r.user_feedback,
                    fix_strategy=r.fix_strategy,
                    regression=bool(r.regression),
                    tokens_used=r.tokens_used,
                    response_time_ms=r.response_time_ms,
                    tags=json.loads(r.tags) if r.tags else [],
                    importance=r.importance,
                    injected_context_size=r.injected_context_size,
                )
            )
        return results

    def delete_outcome(self, outcome_id: int) -> bool:
        """Delete a recorded learning outcome by id."""
        return self.delete_outcome_with_related(outcome_id)["deleted"]

    def delete_outcome_with_related(self, outcome_id: int) -> dict:
        """Delete a learning outcome and conservatively clean linked auto-patterns.

        Historical rows do not have a foreign-key relation from patterns back to
        outcomes, so this only touches patterns whose generated failure
        description exactly matches the deleted outcome. Shared patterns are
        decremented instead of deleted.
        """
        linked_patterns: list[dict] = []
        with get_session() as session:
            row = session.get(LearningOutcome, outcome_id)
            if row is None:
                return {
                    "deleted": False,
                    "linked_patterns": linked_patterns,
                }

            if row.success == 0 and row.error_message:
                expected_description = _failure_pattern_description(
                    row.error_message,
                    row.user_input,
                )
                patterns = (
                    session.query(LearningPattern)
                    .filter(
                        LearningPattern.pattern_type == "failure",
                        LearningPattern.description == expected_description,
                    )
                    .all()
                )
                now = datetime.now().isoformat(timespec="seconds")
                for pattern in patterns:
                    if pattern.frequency > 1:
                        pattern.frequency -= 1
                        pattern.updated_at = now
                        action = "decremented"
                    else:
                        session.delete(pattern)
                        action = "deleted"
                    linked_patterns.append(
                        {
                            "id": int(pattern.id),
                            "pattern_type": pattern.pattern_type,
                            "action": action,
                        }
                    )

            session.delete(row)
            return {
                "deleted": True,
                "linked_patterns": linked_patterns,
            }

    # -- injection -----------------------------------------------------------

    def build_injection_context(self, user_input: str) -> str:
        """Build context string from relevant past learnings for injection into model prompt.

        This is the core mechanism that proves learning impacts answers:
        past failures → fix strategies → injected into new prompts.
        """
        import re as _re

        input_lower = (user_input or "").lower()
        input_words = set(_re.findall(r"\w+", input_lower)) if input_lower else set()

        # Collect all candidate items with category tags, score by token overlap
        scored: list[tuple[int, str, str]] = []  # (score, category_label, line)

        # 1. Recently failed patterns to avoid
        failures = self.get_patterns(pattern_type="failure", limit=10)
        for f in failures:
            desc = f['description'][:200]
            line = f"- (seen {f['frequency']}x) {desc}"
            score = len(input_words & set(_re.findall(r"\w+", desc.lower()))) if input_words else 1
            scored.append((score, "## Learned: Past Failures to Avoid", line))

        # 2. Successful fix strategies
        fixes = self.get_patterns(pattern_type="fix", limit=6)
        for f in fixes:
            desc = f['description'][:200]
            line = f"- {desc}"
            score = len(input_words & set(_re.findall(r"\w+", desc.lower()))) if input_words else 1
            scored.append((score, "## Learned: Fix Strategies That Worked", line))

        # 3. User preferences/conventions
        prefs = self.get_patterns(pattern_type="preference", limit=10)
        for p in prefs:
            desc = p['description'][:200]
            line = f"- {desc}"
            score = len(input_words & set(_re.findall(r"\w+", desc.lower()))) if input_words else 1
            scored.append((score, "## Learned: User Preferences", line))

        # 4. Recent relevant outcomes
        outcomes = self.get_outcomes(limit=10)
        for o in outcomes:
            ui_text = (o.user_input or "")[:100]
            status = "OK" if o.success else f"FAIL ({o.error_type})"
            line = f"- [{status}] {ui_text}"
            score = len(input_words & set(_re.findall(r"\w+", ui_text.lower()))) if input_words else 1
            scored.append((score, "## Recent Session Outcomes", line))

        # Sort by relevance score descending, then build grouped output
        scored.sort(key=lambda x: x[0], reverse=True)
        seen_categories: set[str] = set()
        parts: list[str] = []
        for score, category, line in scored:
            if score == 0:
                continue  # skip items with no relevance overlap
            if category not in seen_categories:
                seen_categories.add(category)
                parts.append(category)
            parts.append(line)

        # Fallback: if nothing matched, return top items unsorted (original behavior)
        if not parts:
            if failures:
                parts.append("## Learned: Past Failures to Avoid")
                for f in failures[:5]:
                    parts.append(f"- (seen {f['frequency']}x) {f['description'][:200]}")
            if fixes:
                parts.append("## Learned: Fix Strategies That Worked")
                for f in fixes[:3]:
                    parts.append(f"- {f['description'][:200]}")

        return "\n".join(parts) if parts else ""

    # -- statistics ----------------------------------------------------------

    def get_stats(self) -> LearningStats:
        """Compute learning statistics — measurable proof."""
        with get_session() as session:
            total = session.query(func.count(LearningOutcome.id)).scalar() or 0
            ok = session.query(func.count(LearningOutcome.id)).filter(LearningOutcome.success == 1).scalar() or 0
            fail = total - ok
            corrections = session.query(func.count(LearningOutcome.id)).filter(LearningOutcome.user_feedback != "").scalar() or 0
            regressions = session.query(func.count(LearningOutcome.id)).filter(LearningOutcome.regression == 1).scalar() or 0
            patterns = session.query(func.count(LearningPattern.id)).scalar() or 0
            fixes = session.query(func.count(LearningPattern.id)).filter(LearningPattern.pattern_type == "fix").scalar() or 0
            injection_total = (
                session.query(func.sum(case((LearningOutcome.injected_context_size > 0, 1), else_=0)))
                .scalar()
                or 0
            )

        # Last 5 learnings
        recent = self.get_outcomes(limit=5)
        top_tags: dict[str, int] = {}
        for o in recent:
            for t in o.tags:
                top_tags[t] = top_tags.get(t, 0) + 1

        sorted_tags = sorted(top_tags, key=top_tags.get, reverse=True)[:5]

        return LearningStats(
            total_turns=total,
            successful_turns=ok,
            failed_turns=fail,
            success_rate=round(ok / max(total, 1), 3),
            patterns_discovered=patterns,
            fix_strategies_learned=fixes,
            regressions_caught=regressions,
            user_corrections=corrections,
            injections_per_turn=round(injection_total / max(total, 1), 2),
            top_tags=sorted_tags,
            recent_learnings=[
                {
                    "id": o.outcome_id,
                    "input": o.user_input[:100],
                    "success": o.success,
                    "feedback": o.user_feedback,
                    "injected_context_size": o.injected_context_size,
                    "injected": o.injected_context_size > 0,
                }
                for o in recent[:5]
            ],
        )

    def get_injection_impact(self, min_sample: int = 3) -> InjectionImpact:
        """Compare observed success for turns with and without injected learning.

        This is not a randomized experiment; it is an operational A/B-style
        telemetry view over recorded outcomes. The status remains
        ``insufficient_data`` until both cohorts have enough samples.
        """
        if min_sample < 1:
            min_sample = 1
        with get_session() as session:
            injected_turns = (
                session.query(func.count(LearningOutcome.id))
                .filter(LearningOutcome.injected_context_size > 0)
                .scalar()
                or 0
            )
            injected_successes = (
                session.query(func.count(LearningOutcome.id))
                .filter(
                    LearningOutcome.injected_context_size > 0,
                    LearningOutcome.success == 1,
                )
                .scalar()
                or 0
            )
            baseline_turns = (
                session.query(func.count(LearningOutcome.id))
                .filter(LearningOutcome.injected_context_size <= 0)
                .scalar()
                or 0
            )
            baseline_successes = (
                session.query(func.count(LearningOutcome.id))
                .filter(
                    LearningOutcome.injected_context_size <= 0,
                    LearningOutcome.success == 1,
                )
                .scalar()
                or 0
            )

        injected_rate = round(injected_successes / max(injected_turns, 1), 3)
        baseline_rate = round(baseline_successes / max(baseline_turns, 1), 3)
        enough = injected_turns >= min_sample and baseline_turns >= min_sample
        return InjectionImpact(
            injected_turns=injected_turns,
            injected_successes=injected_successes,
            injected_success_rate=injected_rate,
            baseline_turns=baseline_turns,
            baseline_successes=baseline_successes,
            baseline_success_rate=baseline_rate,
            uplift=round(injected_rate - baseline_rate, 3) if enough else 0.0,
            status="measured" if enough else "insufficient_data",
            min_sample=min_sample,
        )

    def stats_summary(self) -> str:
        """Human-readable learning statistics."""
        s = self.get_stats()
        lines = [
            "Learning System Statistics",
            f"  Turns recorded:  {s.total_turns}",
            f"  Success rate:    {s.success_rate:.1%} ({s.successful_turns}/{s.total_turns})",
            f"  Failures:        {s.failed_turns}",
            f"  Patterns found:  {s.patterns_discovered}",
            f"  Fix strategies:  {s.fix_strategies_learned}",
            f"  Regressions:     {s.regressions_caught}",
            f"  Corrections:     {s.user_corrections}",
        ]
        if s.top_tags:
            lines.append(f"  Top tags:        {', '.join(s.top_tags)}")
        if s.recent_learnings:
            lines.append("  Recent:")
            for r in s.recent_learnings[:3]:
                status = "OK" if r["success"] else "FAIL"
                fb = f" [{r['feedback']}]" if r["feedback"] else ""
                injected = "injected" if r.get("injected") else "no-injection"
                lines.append(f"    #{r['id']} [{status}, {injected}] {r['input']}{fb}")
        return "\n".join(lines)


# ====================================================================
# Singleton
# ====================================================================

_LEARNING: LearningSystem | None = None


def get_learning_system() -> LearningSystem:
    global _LEARNING
    if _LEARNING is None:
        _LEARNING = LearningSystem()
    return _LEARNING


# ====================================================================
# Quick functions
# ====================================================================


def record(user_input: str, answer: str = "", success: bool = True, **kwargs) -> int:
    """Record a turn outcome."""
    return get_learning_system().record_turn(user_input, answer, success, **kwargs)


def stats() -> str:
    """Get learning statistics."""
    return get_learning_system().stats_summary()


def inject(user_input: str) -> str:
    """Build injection context for a user input."""
    return get_learning_system().build_injection_context(user_input)


def undo(learning_id: int) -> bool:
    """Delete a recorded learning outcome by id."""
    return get_learning_system().delete_outcome(learning_id)


# ====================================================================
# Compatibility
# ====================================================================


def _init_db():
    """兼容旧代码 — 表由 arforge.database.init_db() 自动创建."""
    from arforge.database import init_db
    init_db()


def get_db_path() -> str:
    """兼容旧代码 — 返回默认数据库路径."""
    from arforge import get_db_path as _gdp
    return _gdp()


def _failure_pattern_description(error_message: str, user_input: str) -> str:
    return f"Error: {error_message[:200]} | Input: {user_input[:100]}"
