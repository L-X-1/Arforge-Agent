"""Real learning engine - pattern extraction, intelligent injection, consolidation, dreaming."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime

from arforge.database import LearningOutcome, LearningPattern, get_session
from arforge.learning_schema import InjectionContext, InjectionResult

@dataclass
class ExtractedPattern:
    pattern_type: str
    description: str
    frequency: int = 1
    confidence: float = 0.5
    tags: list = field(default_factory=list)
    source_turn_ids: list = field(default_factory=list)

class PatternExtractor:
    def __init__(self, session_factory=None):
        self._sf = session_factory or get_session

    def extract_failure_patterns(self, limit=200, min_frequency=2):
        with self._sf() as s:
            rows = s.query(LearningOutcome).filter(
                LearningOutcome.success == 0
            ).order_by(LearningOutcome.id.desc()).limit(limit).all()
        if len(rows) < min_frequency:
            return []
        groups = {}
        for r in rows:
            et = r.error_type or "unknown"
            em = (r.error_message or "")[:120]
            key = f"{et}:{em}" if em else et
            groups.setdefault(key, []).append(r)
        result = []
        for key, group in groups.items():
            if len(group) < min_frequency:
                continue
            f = group[0]
            et = f.error_type or "unknown"
            em = (f.error_message or "")[:200]
            desc = f"[{et}] {em}" if em else f"Error type: {et}"
            tags_raw = json.loads(f.tags) if f.tags else []
            result.append(ExtractedPattern(
                "failure", desc, len(group),
                min(0.9, 0.3 + 0.1 * len(group)),
                [et] + tags_raw,
                [int(r.id) for r in group],
            ))
        return result

    def extract_fix_strategies(self, limit=200, min_frequency=1):
        with self._sf() as s:
            rows = s.query(LearningOutcome).filter(
                LearningOutcome.fix_strategy != "",
                LearningOutcome.success == 1,
            ).order_by(LearningOutcome.id.desc()).limit(limit).all()
        if not rows:
            return []
        groups = {}
        for r in rows:
            key = (r.fix_strategy or "")[:120]
            if key:
                groups.setdefault(key, []).append(r)
        result = []
        for key, group in groups.items():
            if len(group) < min_frequency:
                continue
            result.append(ExtractedPattern(
                "fix", f"Fix: {key}", len(group),
                min(0.95, 0.4 + 0.1 * len(group)),
                ["fix", "successful"],
                [int(r.id) for r in group],
            ))
        return result

    def extract_preferences(self, limit=200):
        with self._sf() as s:
            rows = s.query(LearningOutcome).filter(
                LearningOutcome.user_feedback != ""
            ).order_by(LearningOutcome.id.desc()).limit(limit).all()
        if not rows:
            return []
        result = []
        detail_kw = ["detailed", "brief", "too long", "too short"]
        detail_rows = [r for r in rows if any(
            kw in (r.user_feedback or "").lower() for kw in detail_kw
        )]
        if detail_rows:
            prefers_detailed = sum(1 for r in detail_rows if any(
                kw in (r.user_feedback or "").lower()
                for kw in ["detailed", "too short"]
            )) > len(detail_rows) / 2
            result.append(ExtractedPattern(
                "preference",
                f"User prefers {'detailed' if prefers_detailed else 'concise'} responses ({len(detail_rows)} signals)",
                len(detail_rows),
                min(0.85, 0.3 + 0.1 * len(detail_rows)),
                ["preference", "detail_level"],
                [int(r.id) for r in detail_rows],
            ))
        code_kw = ["code", "style", "format"]
        code_rows = [r for r in rows if any(
            kw in (r.user_feedback or "").lower() for kw in code_kw
        )]
        if code_rows:
            result.append(ExtractedPattern(
                "preference",
                f"User has code style preferences ({len(code_rows)} signals)",
                len(code_rows),
                min(0.7, 0.3 + 0.05 * len(code_rows)),
                ["preference", "code_style"],
                [int(r.id) for r in code_rows],
            ))
        return result

    def detect_regressions(self, limit=200):
        with self._sf() as s:
            rows = s.query(LearningOutcome).filter(
                LearningOutcome.regression == 1
            ).order_by(LearningOutcome.id.desc()).limit(limit).all()
        if not rows:
            return []
        result = []
        for r in rows:
            et = r.error_type or "unknown"
            em = (r.error_message or "")[:200]
            result.append(ExtractedPattern(
                "failure", f"REGRESSION: [{et}] {em}",
                1, 0.9, ["regression", et], [int(r.id)],
            ))
        return result

    def extract_all(self, limit=200):
        all_p = []
        all_p.extend(self.extract_failure_patterns(limit))
        all_p.extend(self.extract_fix_strategies(limit))
        all_p.extend(self.extract_preferences(limit))
        all_p.extend(self.detect_regressions(limit))
        return all_p

class InjectionPipeline:
    def __init__(self, session_factory=None):
        self._sf = session_factory or get_session
        self._extractor = PatternExtractor(session_factory)

    def inject(self, context):
        results = []
        fps = self._extractor.extract_failure_patterns(100, 1)
        for p in fps[:5]:
            c = f"[Learned Pattern - {p.pattern_type}] {p.description} (seen {p.frequency}x, confidence {p.confidence:.0%})"
            t = max(1, len(c) // 4)
            sid = p.source_turn_ids[0] if p.source_turn_ids else 0
            results.append(InjectionResult("learning_outcomes", sid, "failure_pattern", c, t, 100))
        fixes = self._extractor.extract_fix_strategies(100, 1)
        for p in fixes[:3]:
            c = f"[Learned Fix] {p.description} (worked {p.frequency}x, confidence {p.confidence:.0%})"
            t = max(1, len(c) // 4)
            sid = p.source_turn_ids[0] if p.source_turn_ids else 0
            results.append(InjectionResult("learning_outcomes", sid, "fix_strategy", c, t, 90))
        prefs = self._extractor.extract_preferences(100)
        for p in prefs[:2]:
            c = f"[Learned Preference] {p.description}"
            t = max(1, len(c) // 4)
            sid = p.source_turn_ids[0] if p.source_turn_ids else 0
            results.append(InjectionResult("learning_outcomes", sid, "preference", c, t, 80))
        regs = self._extractor.detect_regressions(50)
        for p in regs[:2]:
            c = f"[REGRESSION ALERT] {p.description}"
            t = max(1, len(c) // 4)
            sid = p.source_turn_ids[0] if p.source_turn_ids else 0
            results.append(InjectionResult("learning_outcomes", sid, "regression", c, t, 95))
        with self._sf() as s:
            err_rows = s.query(LearningOutcome).filter(
                LearningOutcome.success == 0
            ).order_by(LearningOutcome.id.desc()).limit(20).all()
        errors = [
            {"id": int(r.id), "error_type": r.error_type or "",
             "error_message": r.error_message or "",
             "user_input": r.user_input or "",
             "fix_strategy": r.fix_strategy or ""}
            for r in err_rows
        ]
        input_lower = (context.user_input or "").lower()
        if input_lower:
            scored = []
            for e in errors:
                score = 0
                et = e.get("error_type", "").lower()
                if et and et in input_lower:
                    score += 5
                em = e.get("error_message", "").lower()
                ui = e.get("user_input", "").lower()
                input_words = set(re.findall(r"\w+", input_lower))
                err_words = set(re.findall(r"\w+", em + " " + ui))
                score += len(input_words & err_words) * 3
                scored.append((score, e))
            scored.sort(key=lambda x: x[0], reverse=True)
            matched = [e for sc, e in scored if sc > 0][:2]
        else:
            matched = errors[:2]
        for e in matched:
            c = f"[Recent Error] {e['error_type']}: {e['error_message'][:200]}"
            t = max(1, len(c) // 4)
            results.append(InjectionResult("learning_outcomes", e.get("id", 0), "recent_error", c, t, 70))
        results.sort(key=lambda r: r.priority, reverse=True)
        return results

class ConsolidationEngine:
    def __init__(self, session_factory=None):
        self._sf = session_factory or get_session
        self._extractor = PatternExtractor(session_factory)

    def consolidate(self):
        patterns = self._extractor.extract_all(500)
        saved = 0
        updated = 0
        with self._sf() as s:
            existing = s.query(LearningPattern).all()
            ed = {p.description[:120]: p for p in existing}
            for p in patterns:
                key = p.description[:120]
                if key in ed:
                    ep = ed[key]
                    ep.frequency = p.frequency
                    ep.confidence = p.confidence
                    ep.updated_at = datetime.now().isoformat(timespec="seconds")
                    updated += 1
                else:
                    lp = LearningPattern(
                        created_at=datetime.now().isoformat(timespec="seconds"),
                        updated_at=datetime.now().isoformat(timespec="seconds"),
                        pattern_type=p.pattern_type,
                        description=p.description,
                        frequency=p.frequency,
                        confidence=p.confidence,
                        tags=json.dumps(p.tags, ensure_ascii=False),
                    )
                    s.add(lp)
                    saved += 1
        return {
            "patterns_found": len(patterns),
            "saved_new": saved,
            "updated_existing": updated,
            "patterns": len(patterns),
            "breakdown": {
                "failure": sum(1 for p in patterns if p.pattern_type == "failure"),
                "fix": sum(1 for p in patterns if p.pattern_type == "fix"),
                "preference": sum(1 for p in patterns if p.pattern_type == "preference"),
            },
        }

class DreamingEngine:
    def __init__(self, session_factory=None):
        self._sf = session_factory or get_session
        self._extractor = PatternExtractor(session_factory)

    def run_once(self):
        with self._sf() as s:
            total = s.query(LearningOutcome).count() or 0
            failures = s.query(LearningOutcome).filter(
                LearningOutcome.success == 0
            ).count() or 0
            pc = s.query(LearningPattern).count() or 0
        insights = []
        suggestions = []
        if total > 10:
            sr = (total - failures) / total
            if sr < 0.7:
                insights.append(
                    f"Success rate is low ({sr:.0%}); {failures}/{total} failures."
                )
                suggestions.append("Run /learn consolidate to extract failure patterns")
            elif sr >= 0.9:
                insights.append(
                    f"Success rate is high ({sr:.0%}); system is performing well."
                )
        with self._sf() as s:
            pt = [t[0] for t in s.query(LearningPattern.pattern_type).distinct().all()]
        if "fix" not in pt:
            suggestions.append("No fix strategies learned yet. Run /learn consolidate.")
        if "preference" not in pt:
            suggestions.append("No user preferences detected. More feedback needed.")
        fp = self._extractor.extract_failure_patterns(50, 2)
        if fp:
            top = fp[0]
            insights.append(
                f"Top failure: {top.description[:120]} "
                f"(seen {top.frequency}x, confidence {top.confidence:.0%})"
            )
            suggestions.append(f"Address top failure: {top.description[:80]}")
        with self._sf() as s:
            all_p = s.query(LearningPattern).all()
        stale = [p for p in all_p if p.frequency == 1 and p.confidence < 0.4]
        if stale:
            insights.append(
                f"{len(stale)} low-confidence patterns ({len(all_p)} total); "
                "more data needed."
            )
        return {
            "total_turns": total,
            "total_failures": failures,
            "total_patterns": pc,
            "insights": insights,
            "suggestions": suggestions,
            "timestamp": datetime.now().isoformat(timespec="seconds"),
        }

    def reflect(self, use_llm: bool = False) -> list[str]:
        """Reflect on learning outcomes and produce insights + suggestions.

        When use_llm=True (3.2), feeds recent failed outcomes to the LLM
        for root-cause analysis, improvement suggestions, and pattern drafts.
        Results are persisted as LearningPattern entries.
        """
        # Always run statistical analysis first
        r = self.run_once()
        insights = r.get("insights", [])
        suggestions = r.get("suggestions", [])

        if not use_llm:
            return insights + suggestions

        # LLM-driven deep reflection: analyze recent failures
        with self._sf() as s:
            recent_failures = (
                s.query(LearningOutcome)
                .filter(LearningOutcome.success == 0)
                .order_by(LearningOutcome.id.desc())
                .limit(10)
                .all()
            )

        if not recent_failures:
            insights.append("[LLM reflect] No recent failures to analyze.")
            return insights + suggestions

        # Build prompt with failure summaries
        failure_text = "\n".join(
            f"- [{o.error_type or 'UNKNOWN'}] {o.error_message or o.user_input[:120]}"
            for o in recent_failures
        )

        prompt = (
            "You are analyzing recent failures from an AI coding agent. "
            "Identify the root cause of these failures, suggest concrete improvements, "
            "and draft a learning pattern that could prevent similar failures.\n\n"
            f"Recent failures ({len(recent_failures)}):\n{failure_text}\n\n"
            "Output JSON with keys: root_cause (str), improvement (str), "
            "pattern_type (str: fix/preference/guard/error), pattern_description (str)."
        )

        try:
            from arforge.product.model_config_runtime import get_model_config
            from arforge.models.structured import generate_structured

            adapter = get_model_config().create_active_adapter()
            data = generate_structured(
                adapter,
                [{"role": "user", "content": prompt}],
                required_keys=["root_cause", "improvement", "pattern_description"],
                max_tokens=512,
                temperature=0.3,
            )
            if data:
                insights.append(f"[LLM] Root cause: {data.get('root_cause', 'unknown')}")
                suggestions.append(data.get("improvement", "No specific improvement"))

                # Persist as a learning pattern
                from arforge.learning_system import get_learning_system
                ls = get_learning_system()
                ls.add_pattern(
                    pattern_type=data.get("pattern_type", "fix"),
                    description=data["pattern_description"][:300],
                    tags=["llm-reflect", "auto-generated"],
                    confidence=0.7,
                )
                insights.append(
                    f"[LLM] Pattern drafted: {data['pattern_description'][:80]}..."
                )
        except Exception as e:
            insights.append(f"[LLM reflect] Model analysis failed: {e}")
            suggestions.append("Check API configuration for LLM reflection.")

        return insights + suggestions

class LearningEngine:
    def __init__(self):
        from arforge.learning_system import get_learning_system
        self._system = get_learning_system()
        self._extractor = PatternExtractor()
        self._injection = InjectionPipeline()
        self._consolidation = ConsolidationEngine()
        self._dreaming = DreamingEngine()

    def record_turn(self, user_input, assistant_response="", route_type="unknown", **kwargs):
        has_error = kwargs.get("has_error", False)
        return self._system.record_turn(
            user_input=user_input,
            answer=assistant_response,
            success=kwargs.get("success", not has_error),
            intent=kwargs.get("intent", "general"),
            route=route_type or kwargs.get("route", "unknown"),
            tools=kwargs.get("tools", []),
            error=kwargs.get("error_message", kwargs.get("error", "")),
            error_type=kwargs.get("error_type", ""),
            feedback=kwargs.get("feedback", ""),
            injected_context_size=kwargs.get("injected_context_size", 0),
        )

    def get_injections(self, context):
        return self._injection.inject(context)

    def build_injection_text(self, user_input, route_type="unknown"):
        ctx = InjectionContext(user_input=user_input, route_type=route_type)
        results = self.get_injections(ctx)
        if not results:
            return ""
        lines = ["## Learning System Context", ""]
        for r in results:
            lines.append(f"- {r.content}")
        return "\n".join(lines)

    def extract_patterns(self, limit=200):
        return self._extractor.extract_all(limit)

    def get_frequent_errors(self, limit=20):
        patterns = self._extractor.extract_failure_patterns(100, 1)
        return [p.description for p in patterns[:limit]]

    def consolidate(self):
        return self._consolidation.consolidate()

    def dream(self):
        return self._dreaming.run_once()

    def reflect(self, use_llm: bool = False):
        return self._dreaming.reflect(use_llm=use_llm)

    def stats(self):
        return self._system.stats_summary()

    def get_stats(self):
        return self._system.get_stats()

    def get_injection_impact(self, min_sample=3):
        return self._system.get_injection_impact(min_sample)



# ── T33: Consolidated exports (replaces facade modules) ──

def get_consolidation_status() -> dict:
    """Get the current state of consolidated patterns without running extraction."""
    from arforge.database import LearningPattern, get_session
    with get_session() as session:
        total = session.query(LearningPattern).count() or 0
        by_type = {}
        for pt in session.query(LearningPattern.pattern_type).distinct().all():
            t = pt[0]
            count = session.query(LearningPattern).filter(
                LearningPattern.pattern_type == t).count()
            by_type[t] = count
    return {"total_patterns": total, "by_type": by_type}


def get_dreaming_insights() -> dict:
    """Run dreaming and return only insights and suggestions (lighter)."""
    result = get_learning_engine().dream()
    return {
        "insights": result.get("insights", []),
        "suggestions": result.get("suggestions", []),
        "timestamp": result.get("timestamp", ""),
    }


def build_learning_context(user_input: str, route_type: str = "unknown",
                           max_tokens: int = 1200) -> str:
    """Build learning context string for injection into agent prompt."""
    return get_learning_engine().build_injection_text(user_input, route_type)


def get_injection_summary(user_input: str, route_type: str = "unknown") -> dict:
    """Get a structured summary of what would be injected."""
    engine = get_learning_engine()
    ctx = __import__("arforge.learning_schema", fromlist=["InjectionContext"]).InjectionContext(
        user_input=user_input, route_type=route_type)
    results = engine.get_injections(ctx)
    return {
        "injection_count": len(results),
        "injections": [
            {"type": r.injector_type, "source_id": r.source_id,
             "priority": r.priority, "tokens": r.estimated_tokens}
            for r in results
        ],
        "has_data": len(results) > 0,
    }


def learning_system_info() -> dict:
    """Get learning system metadata."""
    engine = get_learning_engine()
    stats = engine.get_stats()
    return {
        "version": "v2",
        "storage": "sqlite",
        "status": "active",
        "total_turns": stats.total_turns,
        "success_rate": stats.success_rate,
        "patterns_discovered": stats.patterns_discovered,
        "injections_per_turn": stats.injections_per_turn,
    }


def reflect_recent(limit: int = 10, use_llm: bool = False) -> list[str]:
    """Get recent reflections from the dreaming engine."""
    return get_learning_engine().reflect(use_llm=use_llm)


def run_learning_workflow() -> dict:
    """Run a full learning workflow: extract patterns + reflect."""
    from arforge.learning_patterns import extract_patterns
    return {"patterns": extract_patterns(), "reflections": reflect_recent()}


_ENGINE = None

def get_learning_engine():
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = LearningEngine()
    return _ENGINE

def record_turn(user_input, assistant_response="", **kwargs):
    return get_learning_engine().record_turn(user_input, assistant_response, **kwargs)

def get_injections(user_input, route_type="unknown"):
    return get_learning_engine().build_injection_text(user_input, route_type)

def frequent_errors(limit=20):
    return get_learning_engine().get_frequent_errors(limit)

def consolidate():
    return get_learning_engine().consolidate()

def dream():
    return get_learning_engine().dream()


def run_learning_dream() -> dict:
    """Consolidate local outcomes, then produce an offline reflection snapshot.

    This is intentionally deterministic and model-free.  It gives the CLI and
    REPL an explicit, auditable way to turn accumulated outcomes into reusable
    patterns without silently issuing an external model request.
    """
    engine = get_learning_engine()
    return {
        "consolidation": engine.consolidate(),
        "dream": engine.dream(),
    }


def learning_stats():
    return get_learning_engine().stats()
