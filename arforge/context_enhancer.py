"""Context enhancement helpers."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ContextStats:
    input_items: int = 0
    output_chars: int = 0


def enhance_context(context: str, evidence: list[dict] = None) -> tuple[str, ContextStats]:
    evidence = evidence or []
    extra = "\n".join(f"- {item.get('source')}: {item.get('content')}" for item in evidence)
    output = f"{context}\n\nEvidence:\n{extra}".strip() if extra else context
    return output, ContextStats(len(evidence), len(output))
