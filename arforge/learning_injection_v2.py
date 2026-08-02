"""
[Deprecated] Thin facade. Use arforge.learning_engine directly.

All functionality consolidated. This module will be removed.
"""

import warnings as _w
from arforge.learning_engine import InjectionPipeline, get_learning_engine
from arforge.learning_schema import InjectionContext, InjectionResult

_w.warn("arforge.learning_injection_v2 is deprecated - use arforge.learning_engine", DeprecationWarning, stacklevel=2)

__all__ = ["InjectionPipeline", "InjectionContext", "InjectionResult", "get_learning_engine"]
