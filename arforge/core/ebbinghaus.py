# -*- coding: utf-8 -*-
"""Ebbinghaus forgetting curve — time-based memory decay and spaced repetition.

Based on the Ebbinghaus forgetting curve: retention decays exponentially with time.
We use a simplified model:
  R(t) = e^(-t / S)

Where:
  - R(t): retention at time t (0.0–1.0)
  - t: time elapsed since last review (in hours)
  - S: stability factor (increases with each successful review)

Spaced repetition intervals (in hours):
  Level 0 → 1h  (immediate)
  Level 1 → 24h (1 day)
  Level 2 → 72h (3 days)
  Level 3 → 168h (7 days)
  Level 4 → 336h (14 days)
  Level 5 → 720h (30 days)
  Level 6 → 1440h (60 days)
  Level 7 → 4320h (180 days)
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

# Spaced repetition intervals (hours) for each review level
_SPACED_INTERVALS: list[float] = [
    1.0,      # Level 0: 1 hour
    24.0,     # Level 1: 1 day
    72.0,     # Level 2: 3 days
    168.0,    # Level 3: 7 days
    336.0,    # Level 4: 14 days
    720.0,    # Level 5: 30 days
    1440.0,   # Level 6: 60 days
    4320.0,   # Level 7: 180 days
]

# Base stability (hours) — how fast a memory decays without review
_BASE_STABILITY: float = 48.0  # 2 days

# Retention threshold below which a memory is "due for review"
_REVIEW_THRESHOLD: float = 0.6


def retention_at_elapsed(elapsed_hours: float, stability: float | None = None) -> float:
    """Calculate retention using Ebbinghaus exponential decay.

    retention = e^(-elapsed / stability)

    Args:
        elapsed_hours: Time since last review in hours.
        stability: Memory stability factor in hours. Higher = slower decay.
                   Defaults to _BASE_STABILITY.

    Returns:
        Retention value between 0.0 (completely forgotten) and 1.0 (fully retained).
    """
    if stability is None:
        stability = _BASE_STABILITY
    if stability <= 0:
        return 0.0
    if elapsed_hours <= 0:
        return 1.0
    return math.exp(-elapsed_hours / stability)


def stability_for_level(review_level: int) -> float:
    """Compute stability for a given review level.

    Stability increases with each successful review: S = S0 * 2.5^level
    """
    return _BASE_STABILITY * (2.5 ** min(review_level, 7))


def next_review_interval(review_level: int) -> float:
    """Get the recommended interval (hours) before next review."""
    idx = min(review_level, len(_SPACED_INTERVALS) - 1)
    return _SPACED_INTERVALS[idx]


def next_review_due_at(
    last_reviewed_at: str | None,
    review_level: int = 0,
) -> datetime:
    """Calculate when the next review is due."""
    now = datetime.now(timezone.utc)
    if not last_reviewed_at:
        return now + timedelta(hours=next_review_interval(0))

    try:
        last = datetime.fromisoformat(last_reviewed_at)
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return now + timedelta(hours=next_review_interval(0))

    interval_hours = next_review_interval(review_level)
    return last + timedelta(hours=interval_hours)


def is_due_for_review(
    last_reviewed_at: str | None,
    review_level: int = 0,
    threshold: float | None = None,
) -> bool:
    """Check if a memory is due for spaced repetition review."""
    if threshold is None:
        threshold = _REVIEW_THRESHOLD

    if not last_reviewed_at:
        return True  # Never reviewed → due immediately

    try:
        last = datetime.fromisoformat(last_reviewed_at)
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return True

    now = datetime.now(timezone.utc)
    elapsed_hours = (now - last).total_seconds() / 3600.0
    stability = stability_for_level(review_level)
    retention = retention_at_elapsed(elapsed_hours, stability)

    return retention < threshold


def calculate_current_strength(
    created_at: str | None,
    last_reviewed_at: str | None = None,
    review_level: int = 0,
    initial_strength: float = 1.0,
) -> float:
    """Calculate current memory strength factoring in time decay.

    Uses the last review time (or creation time) as the reference point.
    """
    ref_time = last_reviewed_at or created_at
    if not ref_time:
        return max(0.1, initial_strength)

    try:
        ref = datetime.fromisoformat(ref_time)
        if ref.tzinfo is None:
            ref = ref.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return max(0.1, initial_strength)

    now = datetime.now(timezone.utc)
    elapsed_hours = max(0, (now - ref).total_seconds() / 3600.0)
    stability = stability_for_level(review_level)
    retention = retention_at_elapsed(elapsed_hours, stability)

    return max(0.1, initial_strength * retention)


def get_decay_summary(
    created_at: str | None,
    last_reviewed_at: str | None = None,
    review_level: int = 0,
    initial_strength: float = 1.0,
) -> dict:
    """Get a comprehensive decay summary for a single memory."""
    ref_time = last_reviewed_at or created_at
    elapsed_hours = 0.0

    if ref_time:
        try:
            ref = datetime.fromisoformat(ref_time)
            if ref.tzinfo is None:
                ref = ref.replace(tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            elapsed_hours = max(0, (now - ref).total_seconds() / 3600.0)
        except (ValueError, TypeError):
            pass

    stability = stability_for_level(review_level)
    retention = retention_at_elapsed(elapsed_hours, stability)
    current_strength = max(0.1, initial_strength * retention)
    due = retention < _REVIEW_THRESHOLD
    next_due = next_review_due_at(last_reviewed_at, review_level)

    return {
        "current_strength": round(current_strength, 4),
        "retention": round(retention, 4),
        "stability_hours": round(stability, 1),
        "elapsed_hours": round(elapsed_hours, 1),
        "review_level": review_level,
        "is_due": due,
        "next_review_due": next_due.isoformat(),
        "next_interval_hours": next_review_interval(review_level),
    }


def bulk_decay(
    memories: list[dict],
) -> list[dict]:
    """Apply Ebbinghaus decay to a batch of memory records.

    Returns the list augmented with current_strength and is_due fields.
    """
    results = []
    for mem in memories:
        summary = get_decay_summary(
            created_at=mem.get("created_at"),
            last_reviewed_at=mem.get("last_reviewed_at"),
            review_level=mem.get("review_level", 0),
            initial_strength=mem.get("strength", 1.0),
        )
        mem["current_strength"] = summary["current_strength"]
        mem["is_due"] = summary["is_due"]
        mem["retention"] = summary["retention"]
        results.append(mem)
    return results
