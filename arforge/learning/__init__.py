"""Arforge Learning System — unified public API.

The learning system captures patterns from real task outcomes (dogfood data)
and injects relevant guidance into subsequent runs. This package re-exports
from the canonical modules, providing a single import surface.

Canonical modules:
  learning_system     — core engine: record, inject, stats, undo
  learning_schema     — data models: FailureCategory, TurnExperience, InjectionContext
  learning_db         — persistence: init_learning_db, record_experience
  learning_patterns   — pattern extraction from outcomes
  learning_engine     — Ebbinghaus-based spaced repetition engine
  learning_dreaming   — offline pattern consolidation
  learning_injector   — prompt injection for learned patterns
  learning_injection_v2 — v2 injection with confidence scoring
  learning_cli        — CLI: /learn status, /learn undo
  learning            — legacy thin wrapper (re-exports)
  learning_v2         — v2 thin wrapper (re-exports)
"""

from __future__ import annotations

# Core API — always available
from arforge.learning_system import (
    get_learning_system,
    record,
    stats,
    inject,
    undo,
    Outcome,
    Pattern,
    LearningStats,
)

# Schema
from arforge.learning_schema import (
    FailureCategory,
    TurnExperience,
    InjectionContext,
)

# Persistence
from arforge.learning_db import (
    init_learning_db,
    record_experience,
    list_experiences,
)

# Optional modules (may fail if dependencies missing)
try:
    from arforge.learning_patterns import extract_patterns, match_patterns
except ImportError:
    extract_patterns = None  # type: ignore
    match_patterns = None    # type: ignore

try:
    from arforge.learning_engine import LearningEngine, EbbinghausScheduler
except ImportError:
    LearningEngine = None    # type: ignore
    EbbinghausScheduler = None  # type: ignore

try:
    from arforge.learning_engine import (
        build_learning_context as inject_learnings,
        get_injection_summary as get_injection_context,
    )
except ImportError:
    inject_learnings = None     # type: ignore
    get_injection_context = None  # type: ignore


# Learning profile stubs (T9 learning profile management)
_learning_profile_cache: dict[str, list[str]] = {
    "preferred_detail": [],
    "avoid_patterns": [],
    "adjustments": [],
}


def get_learning_adjustments() -> list[str]:
    """Return active learning adjustments as a list of guidance strings."""
    return list(_learning_profile_cache.get("adjustments", []))


def update_learning_profile(turn_count: int, category: str, detail: str) -> None:
    """Record a learning profile update for future injection."""
    _learning_profile_cache.setdefault("preferred_detail", []).append(
        f"{category}: {detail[:120]}"
    )
    if turn_count > 3:
        _learning_profile_cache.setdefault("adjustments", []).append(
            f"Preferred detail ({category}): {detail[:120]}"
        )


def get_learning_profile() -> dict[str, list[str]]:
    """Return the current learning profile dict."""
    return {k: list(v) for k, v in _learning_profile_cache.items()}


def apply_learning_adjustments(messages: list[dict]) -> list[dict]:
    """Prepend a system-level learning adjustment to the message list."""
    adjustments = get_learning_adjustments()
    if not adjustments:
        return list(messages)
    system_msg = {
        "role": "system",
        "content": "Learning adjustments:\n" + "\n".join(f"  - {a}" for a in adjustments),
    }
    return [system_msg] + list(messages)

__all__ = [
    "get_learning_system",
    "record",
    "stats",
    "inject",
    "undo",
    "Outcome",
    "Pattern",
    "LearningStats",
    "FailureCategory",
    "TurnExperience",
    "InjectionContext",
    "init_learning_db",
    "record_experience",
    "list_experiences",
]
