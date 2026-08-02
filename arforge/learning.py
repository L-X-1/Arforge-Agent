"""User-facing learning profile - tracks user preferences from feedback."""

from __future__ import annotations

from dataclasses import dataclass, field

from arforge.learning_db import list_experiences


@dataclass
class LearningProfile:
    preferred_detail: str = "normal"
    recurring_tags: list[str] = field(default_factory=list)
    avoid_patterns: list[str] = field(default_factory=list)


_PROFILE = LearningProfile()


def update_learning_profile(rating: int, response_type: str, user_input: str = "") -> None:
    """Update the learning profile based on user feedback."""
    if rating >= 4 and ("detailed" in user_input.lower() or "详细" in user_input):
        _PROFILE.preferred_detail = "detailed"
    if rating <= 2:
        _PROFILE.avoid_patterns.append(response_type)


def get_learning_adjustments() -> list[str]:
    """Get context adjustments based on learned profile."""
    adjustments = [f"Preferred detail: {_PROFILE.preferred_detail}"]
    if _PROFILE.avoid_patterns:
        adjustments.append("Avoid: " + ", ".join(sorted(set(_PROFILE.avoid_patterns))))
    recent = list_experiences(limit=5)
    if recent:
        adjustments.append(f"Recent experiences: {len(recent)}")
    return adjustments


def apply_learning_adjustments(messages: list[dict], user_input: str = "") -> list[dict]:
    """Apply learning adjustments to message list."""
    adjustments = get_learning_adjustments()
    if not adjustments:
        return messages
    return [{"role": "system", "content": "\n".join(adjustments)}] + list(messages)


def get_learning_profile() -> dict:
    """Get the current learning profile."""
    return {
        "preferred_detail": _PROFILE.preferred_detail,
        "recurring_tags": _PROFILE.recurring_tags,
        "avoid_patterns": list(set(_PROFILE.avoid_patterns)),
        "recent_experiences": len(list_experiences(limit=5)),
    }
