"""Capability CLI — slash commands for inspecting and testing capabilities."""

from __future__ import annotations

from arforge.capability.capability_registry import list_capabilities
from arforge.capability.enhancement_engine import get_capability_engine


def capability_status() -> str:
    """Formatted status of all registered capabilities."""
    caps = list_capabilities()
    if not caps:
        return "No capabilities registered."

    lines = [f"{len(caps)} capabilities registered:", ""]
    for c in caps:
        kind = c["kind"]
        kw = ", ".join(c["keywords"][:5])
        lines.append(f"  [{kind:12s}] {c['name']:25s} — {c['description']}")
        lines.append(f"    keywords: {kw}")
    return "\n".join(lines)


def capability_test(user_input: str) -> str:
    """Run capabilities against an input and show results."""
    engine = get_capability_engine()
    context = engine.run(user_input)

    lines = [
        f"Input: {user_input}",
        f"Capabilities matched: {', '.join(context.metadata.get('capabilities_used', [])) or 'none'}",
        f"Succeeded: {context.metadata.get('succeeded', 0)}/{context.metadata.get('total', 0)}",
        "",
    ]
    for r in context.capability_results:
        status = "OK" if r.success else "FAIL"
        content_preview = r.content[:150] if r.content else r.error
        lines.append(f"  [{status}] {r.capability}")
        lines.append(f"    {content_preview}")
    return "\n".join(lines)


def main() -> int:
    print(capability_status())
    return 0
