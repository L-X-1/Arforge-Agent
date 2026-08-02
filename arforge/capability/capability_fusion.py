"""Fuse capability results."""

from __future__ import annotations

from arforge.capability.capability_schema import CapabilityResult, EnhancementContext
from arforge.capability.evidence_builder import evidence_from_result
from arforge.capability.evidence_fusion import fuse_evidence


def fuse_capability_results(results: list[CapabilityResult]) -> EnhancementContext:
    evidence = []
    for result in results:
        evidence.extend(result.evidence or [evidence_from_result(result)])
    fused = fuse_evidence(evidence)
    return EnhancementContext(capability_results=results, evidence=fused["items"], metadata={"summary": fused["summary"]}, user_input="")


def format_capability_results(results: list[CapabilityResult]) -> str:
    return "\n".join(f"[{'OK' if item.success else 'FAIL'}] {item.capability}: {item.content or item.error}" for item in results)
