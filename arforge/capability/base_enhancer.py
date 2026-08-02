"""Base class for capability enhancers."""

from __future__ import annotations

from arforge.capability.capability_schema import CapabilityResult, EnhancementContext


class BaseEnhancer:
    name = "base"
    description = "Base enhancer"

    def should_run(self, context: EnhancementContext) -> bool:
        return True

    def run(self, context: EnhancementContext) -> CapabilityResult:
        raise NotImplementedError

    def enhance(self, context: EnhancementContext) -> CapabilityResult | None:
        if not self.should_run(context):
            return None
        return self.run(context)
