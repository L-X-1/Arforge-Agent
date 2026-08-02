"""
[Deprecated] Thin facade. Use arforge.learning_engine directly.

All functionality consolidated. This module will be removed.
"""



from __future__ import annotations

import warnings as _w
from arforge.learning_engine import get_learning_engine
from arforge.learning_schema import InjectionContext

_w.warn("arforge.learning_injector is deprecated - use arforge.learning_engine", DeprecationWarning, stacklevel=2)


def build_learning_context(
    user_input: str,
    route_type: str = "unknown",
    max_tokens: int = 1200,
) -> str:
    """Build learning context string for injection into agent prompt.

    Analyzes user input against accumulated learning data and returns
    a formatted context string with relevant patterns, fixes, and preferences.

    Args:
        user_input: Current user input to match against
        route_type: Type of route being executed
        max_tokens: Maximum token budget for injected context

    Returns:
        Formatted string for injection, or empty string if nothing relevant
    """
    engine = get_learning_engine()
    return engine.build_injection_text(user_input, route_type)


def get_injection_summary(user_input: str, route_type: str = "unknown") -> dict:
    """Get a structured summary of what would be injected for a given input.

    Returns:
        Dict with: failure_patterns, fix_strategies, preferences,
                   regressions, recent_errors, total_injections
    """
    engine = get_learning_engine()
    ctx = InjectionContext(user_input=user_input, route_type=route_type)
    results = engine.get_injections(ctx)

    summary = {
        "failure_patterns": [],
        "fix_strategies": [],
        "preferences": [],
        "regressions": [],
        "recent_errors": [],
        "total_injections": len(results),
    }

    for r in results:
        if r.injector_type == "failure_pattern":
            summary["failure_patterns"].append(r.content)
        elif r.injector_type == "fix_strategy":
            summary["fix_strategies"].append(r.content)
        elif r.injector_type == "preference":
            summary["preferences"].append(r.content)
        elif r.injector_type == "regression":
            summary["regressions"].append(r.content)
        elif r.injector_type == "recent_error":
            summary["recent_errors"].append(r.content)

    return summary
