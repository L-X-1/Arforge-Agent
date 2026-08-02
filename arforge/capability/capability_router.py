"""Route user requests to the most relevant capabilities."""

from __future__ import annotations

from dataclasses import dataclass, field

from arforge.capability.capability_registry import REGISTRY
from arforge.capability.capability_schema import Capability, CapabilityRequest


@dataclass
class CapabilityRoute:
    request: CapabilityRequest
    capabilities: list[Capability] = field(default_factory=list)
    reason: str = ""


def route_capabilities(user_input: str, requested: list[str] | None = None, limit: int = 5) -> CapabilityRoute:
    """Determine which capabilities should run for a given user input.

    When `requested` names are provided, use those explicitly.
    Otherwise, match by keyword scoring across all registered capabilities.
    """
    req = CapabilityRequest(user_input=user_input, requested=requested or [])

    if requested:
        caps = []
        for name in requested:
            c = REGISTRY.get(name)
            if c and c.enabled:
                caps.append(c)
        return CapabilityRoute(req, caps, "explicit")

    # Keyword scoring: each keyword match adds 1 point
    matched = REGISTRY.match(user_input, limit=limit)
    return CapabilityRoute(req, matched, "keyword" if matched else "none")


def capability_names_for(user_input: str) -> list[str]:
    """Get capability names that match the user input."""
    route = route_capabilities(user_input)
    return [c.name for c in route.capabilities]
