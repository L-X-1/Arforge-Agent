"""Canonical reasoning-depth contract shared by desktop, Bridge, and CLI.

The public tiers are ``low``, ``medium``, ``high``, and ``ultra``.  The old
``quick``/``normal``/``deep`` values remain accepted as compatibility aliases,
but runtime events and newly built prompts use the public four-tier names.
"""

from __future__ import annotations

import math
from typing import Final


CANONICAL_REASONING_EFFORTS: Final[tuple[str, ...]] = (
    "low",
    "medium",
    "high",
    "ultra",
)

REASONING_EFFORT_ALIASES: Final[dict[str, str]] = {
    "quick": "low",
    "normal": "medium",
    "deep": "high",
}

_STEP_MULTIPLIERS: Final[dict[str, float]] = {
    "low": 0.60,
    "medium": 1.00,
    "high": 1.25,
    "ultra": 1.50,
}

_MULTIAGENT_ITERATIONS: Final[dict[str, int]] = {
    "low": 2,
    "medium": 3,
    "high": 4,
    "ultra": 5,
}


def normalize_reasoning_effort(
    value: str | None,
    *,
    default: str = "medium",
    strict: bool = False,
) -> str:
    """Return one canonical public tier.

    ``strict=True`` raises ``ValueError`` for unknown input.  Non-strict
    callers fall back to ``default`` so persisted legacy or malformed state
    cannot break a run.
    """

    normalized_default = str(default or "medium").strip().casefold()
    normalized_default = REASONING_EFFORT_ALIASES.get(
        normalized_default,
        normalized_default,
    )
    if normalized_default not in CANONICAL_REASONING_EFFORTS:
        normalized_default = "medium"

    candidate = str(value or "").strip().casefold()
    candidate = REASONING_EFFORT_ALIASES.get(candidate, candidate)
    if candidate in CANONICAL_REASONING_EFFORTS:
        return candidate
    if strict:
        accepted = ", ".join(CANONICAL_REASONING_EFFORTS)
        raise ValueError(f"reasoning effort must be one of: {accepted}")
    return normalized_default


def adjust_step_budget(base_steps: int, effort: str | None, *, cap: int = 120) -> int:
    """Scale an automatic tool-loop budget by the selected thinking depth."""

    base = max(1, int(base_steps))
    tier = normalize_reasoning_effort(effort)
    scaled = math.ceil(base * _STEP_MULTIPLIERS[tier])
    return min(max(1, int(cap)), max(1, scaled))


def multiagent_iteration_budget(effort: str | None) -> int:
    """Return the maximum orchestration/refinement rounds for a depth tier."""

    return _MULTIAGENT_ITERATIONS[normalize_reasoning_effort(effort)]

