"""
[Deprecated] Thin facade. Use arforge.learning_engine directly.

All functionality consolidated. This module will be removed.
"""



from __future__ import annotations

import warnings as _w
from arforge.learning_engine import get_learning_engine

_w.warn("arforge.learning_dreaming is deprecated - use arforge.learning_engine", DeprecationWarning, stacklevel=2)


class DreamingEngine:
    """Offline reflection engine that generates insights from accumulated data."""

    def run_once(self) -> dict:
        """Run one dreaming cycle.

        Returns dict with:
          - total_turns, total_failures, total_patterns
          - insights: list of observations about system behavior
          - suggestions: list of actionable improvement suggestions
          - timestamp: when this cycle ran
        """
        return get_learning_engine().dream()

    def reflect(self) -> list[str]:
        """Return reflection strings suitable for learning injection."""
        return get_learning_engine().reflect()


def run_dreaming_once() -> dict:
    """Convenience function to run one dreaming cycle."""
    return DreamingEngine().run_once()


def get_dreaming_insights() -> dict:
    """Run dreaming and return only insights and suggestions (lighter)."""
    result = DreamingEngine().run_once()
    return {
        "insights": result.get("insights", []),
        "suggestions": result.get("suggestions", []),
        "timestamp": result.get("timestamp", ""),
    }
