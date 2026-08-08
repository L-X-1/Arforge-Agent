"""Single source of truth for governed and compatibility lifecycle edges."""

from __future__ import annotations


GOVERNED_TRANSITIONS: dict[str, frozenset[str]] = {
    "created": frozenset({"understanding", "failed"}),
    "understanding": frozenset({"planning", "blocked", "failed", "interrupted"}),
    "planning": frozenset(
        {"executing", "blocked", "waiting_approval", "failed", "interrupted"}
    ),
    "executing": frozenset(
        {
            "verifying",
            "compacting",
            "blocked",
            "waiting_approval",
            "incomplete",
            "failed",
            "interrupted",
        }
    ),
    "verifying": frozenset(
        {"executing", "blocked", "learning", "completed", "incomplete", "failed"}
    ),
    "compacting": frozenset({"executing", "blocked", "failed"}),
    "blocked": frozenset(
        {
            "understanding",
            "planning",
            "executing",
            "waiting_approval",
            "incomplete",
            "failed",
            "interrupted",
        }
    ),
    "waiting_approval": frozenset({"executing", "blocked", "failed", "interrupted"}),
    "learning": frozenset({"completed", "incomplete", "failed"}),
    "completed": frozenset(),
    "incomplete": frozenset({"understanding", "planning"}),
    "failed": frozenset({"rolling_back"}),
    "interrupted": frozenset({"rolling_back"}),
    "rolling_back": frozenset({"rolled_back", "failed"}),
    "rolled_back": frozenset(),
}

_compatibility = {state: set(targets) for state, targets in GOVERNED_TRANSITIONS.items()}
_compatibility["created"].add("planning")
_compatibility["executing"].add("completed")
COMPATIBILITY_TRANSITIONS: dict[str, frozenset[str]] = {
    state: frozenset(targets) for state, targets in _compatibility.items()
}


def transition_allowed(current: str, target: str, *, governed: bool = True) -> bool:
    """Return whether one lifecycle edge is valid in the selected mode."""
    graph = GOVERNED_TRANSITIONS if governed else COMPATIBILITY_TRANSITIONS
    return target in graph.get(current, frozenset())


__all__ = ["COMPATIBILITY_TRANSITIONS", "GOVERNED_TRANSITIONS", "transition_allowed"]
