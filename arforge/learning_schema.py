"""Learning system schema objects."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class FailureCategory(Enum):
    UNKNOWN = "unknown"
    TEST = "test"
    LINT = "lint"
    RUNTIME = "runtime"
    DESIGN = "design"


@dataclass
class TurnExperience:
    session_id: str = ""
    turn_index: int = 0
    timestamp: str = ""
    user_input: str = ""
    assistant_response: str = ""
    route_type: str = "unknown"
    eval_score: Optional[float] = None
    user_feedback: int = 0
    response_time_ms: float = 0.0
    token_count: int = 0
    has_error: bool = False
    error_type: str = ""
    error_message: str = ""
    fix_strategy: str = ""
    fix_success: int = 0
    tools_used: list[str] = field(default_factory=list)
    tool_success_rate: float = 0.0
    tags: str = ""
    importance: float = 0.0
    is_reflected: int = 0


@dataclass
class InjectionContext:
    user_input: str = ""
    messages: list = field(default_factory=list)
    route_type: str = "unknown"
    turn_index: int = 0
    session_id: str = ""
    available_tokens: int = 8000
    code_context: str = ""
    tool_results: list = field(default_factory=list)
    error_context: str = ""


@dataclass
class InjectionResult:
    source_table: str = ""
    source_id: int = 0
    injector_type: str = ""
    content: str = ""
    estimated_tokens: int = 0
    priority: int = 0
