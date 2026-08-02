"""Capability enhancement engine — routes requests through relevant capabilities.

Pipeline: user_input → route_capabilities → execute handlers → build evidence →
           inject evidence into model context → enhanced answer
"""

from __future__ import annotations

from arforge.capability.capability_router import route_capabilities
from arforge.capability.capability_schema import CapabilityResult, EnhancementContext
from arforge.capability.evidence_builder import build_evidence


class CapabilityEngine:
    """Main engine that orchestrates capability execution and evidence injection."""

    def run(self, user_input: str, requested: list[str] | None = None) -> EnhancementContext:
        """Execute all matching capabilities for a user input.

        Returns an EnhancementContext with results and evidence.
        """
        route = route_capabilities(user_input, requested=requested)
        results: list[CapabilityResult] = []

        for cap in route.capabilities:
            if cap.handler is None:
                continue
            try:
                value = cap.handler(user_input)
                # Resolve kind string
                kind_str = cap.kind.value if hasattr(cap.kind, "value") else str(cap.kind)
                # Build result
                result = CapabilityResult(
                    capability=cap.name,
                    success=True,
                    content=str(value),
                    evidence=[build_evidence(cap.name, str(value)[:500], 0.9)],
                    metadata={"kind": kind_str, "description": cap.description},
                )
            except Exception as exc:
                result = CapabilityResult(
                    capability=cap.name,
                    success=False,
                    error=str(exc),
                )
            results.append(result)

        # Aggregate evidence
        evidence = []
        for r in results:
            if r.evidence:
                evidence.extend(r.evidence)

        return EnhancementContext(
            user_input=user_input,
            capability_results=results,
            evidence=evidence,
            metadata={
                "route_reason": route.reason,
                "capabilities_used": [r.capability for r in results],
                "total": len(results),
                "succeeded": sum(1 for r in results if r.success),
            },
        )

    def enhance_answer(self, user_input: str, base_answer: str = "") -> str:
        """Run capabilities and return an enhanced answer with evidence appended."""
        context = self.run(user_input)

        if not context.evidence:
            return base_answer or "(no capabilities matched — try a more specific query)"

        # Build evidence summary
        lines = ["", "---", "**Capability Evidence**"]
        for r in context.capability_results:
            status = "✓" if r.success else f"✗ ({r.error})"
            lines.append(f"  [{status}] {r.capability}: {r.content[:200]}")
        evidence_block = "\n".join(lines)

        if base_answer:
            return base_answer + "\n" + evidence_block
        return evidence_block

    def list_routes(self) -> list[dict]:
        """Return all registered capabilities as a list of dicts."""
        from arforge.capability.capability_registry import list_capabilities

        return list_capabilities()

    def get_route(self, user_input: str) -> list[str]:
        """Get capability names that match the given input."""
        route = route_capabilities(user_input)
        return [c.name for c in route.capabilities]


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_ENGINE: CapabilityEngine | None = None


def get_capability_engine() -> CapabilityEngine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = CapabilityEngine()
    return _ENGINE


def run_capability_enhancement(user_input: str, requested: list[str] | None = None) -> EnhancementContext:
    return get_capability_engine().run(user_input, requested)


def capability_names_for(user_input: str) -> list[str]:
    """Convenience: get capability names matching user input."""
    return get_capability_engine().get_route(user_input)
