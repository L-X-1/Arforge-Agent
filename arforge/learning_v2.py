"""
[Deprecated] Thin facade. Use arforge.learning_engine directly.

All functionality consolidated. This module will be removed.
"""

import warnings as _w
from arforge.learning_engine import LearningEngine, get_learning_engine, consolidate, dream, frequent_errors, learning_stats, record_turn, get_injections
from arforge.learning_schema import InjectionContext, InjectionResult, TurnExperience

_w.warn("arforge.learning_v2 is deprecated - use arforge.learning_engine", DeprecationWarning, stacklevel=2)

__all__ = [
    "LearningEngine",
    "get_learning_engine",
    "InjectionContext",
    "InjectionResult",
    "TurnExperience",
    "record_turn",
    "get_injections",
    "consolidate",
    "dream",
    "frequent_errors",
    "learning_stats",
]
