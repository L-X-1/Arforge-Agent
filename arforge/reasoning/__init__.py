"""Arforge Reasoning Engine — structured multi-stage reasoning pipeline.

Provides model-driven reasoning with three effort tiers:
  - quick  — brisk <thinking> + <answer> only
  - normal — full 5‑tag framework (understand→think→evidence→reflect→answer)
  - deep   — 5‑tag + alternatives + risk_analysis + verification
"""

from arforge.reasoning.parser import ReasoningResult, parse_reasoning, extract_answer_only, strip_reasoning_tags
from arforge.reasoning.pipeline import ReasoningContext, ReasoningPipeline, quick_reason
from arforge.reasoning.prompts import (
    QUICK_REASONING_PROMPT,
    NORMAL_REASONING_PROMPT,
    DEEP_REASONING_PROMPT,
    EFFORT_PROMPTS,
    EFFORT_REQUIRED_TAGS,
    select_reasoning_by_effort,
    build_reasoning_system_prompt,
)

__all__ = [
    # Pipeline
    "ReasoningPipeline",
    "ReasoningContext",
    "quick_reason",
    # Parser
    "ReasoningResult",
    "parse_reasoning",
    "extract_answer_only",
    "strip_reasoning_tags",
    # Prompts — three-tier
    "QUICK_REASONING_PROMPT",
    "NORMAL_REASONING_PROMPT",
    "DEEP_REASONING_PROMPT",
    "EFFORT_PROMPTS",
    "EFFORT_REQUIRED_TAGS",
    "select_reasoning_by_effort",
    "build_reasoning_system_prompt",
]
