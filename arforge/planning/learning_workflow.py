"""Learning workflow for planning layer - delegates to learning engine."""

from __future__ import annotations

from arforge.learning_engine import get_learning_engine
from arforge.learning_patterns import extract_patterns


def run_learning_workflow() -> dict:
    """Run the learning workflow: extract patterns and get reflections."""
    engine = get_learning_engine()
    return {
        "patterns": extract_patterns(),
        "reflections": engine.reflect(),
        "consolidation_status": engine.dream(),
    }
