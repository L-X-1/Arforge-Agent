"""Capability data structures."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable


class CapabilityKind(Enum):
    TOOL = "tool"
    MEMORY = "memory"
    CONTEXT = "context"
    SECURITY = "security"
    MODEL = "model"
    MULTIMODAL = "multimodal"


@dataclass
class Capability:
    name: str
    description: str
    kind: CapabilityKind | str = CapabilityKind.TOOL
    keywords: list[str] = field(default_factory=list)
    priority: int = 100
    handler: Callable[..., Any] | None = None
    enabled: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)

    def matches(self, text: str) -> bool:
        lowered = text.lower()
        return self.enabled and any(keyword.lower() in lowered for keyword in self.keywords)


@dataclass
class CapabilityRequest:
    user_input: str
    context: dict[str, Any] = field(default_factory=dict)
    requested: list[str] = field(default_factory=list)


@dataclass
class CapabilityResult:
    capability: str
    success: bool
    content: str = ""
    evidence: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    error: str = ""


@dataclass
class EnhancementContext:
    user_input: str
    base_answer: str = ""
    capability_results: list[CapabilityResult] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
