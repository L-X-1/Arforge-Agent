"""ReasoningPipeline — unified multi-stage reasoning engine for Arforge Agent.

Design inspired by GLM5.2's structured reasoning approach:
  UNDERSTAND → THINK → GATHER → VERIFY → ANSWER

All stages execute in a SINGLE model call through structured system prompts.
The model outputs XML-tagged reasoning blocks that are parsed into a ReasoningResult.

Key features:
  - Model-driven reasoning (not hardcoded keyword matching)
  - Structured XML output with robust fallback parsing
  - Task-aware prompt selection (coding / planning / general / quick)
  - Evidence-first approach to prevent hallucination
  - Self-reflection and uncertainty acknowledgment
  - Streaming support with incremental reasoning display
"""

from __future__ import annotations

from dataclasses import dataclass

from arforge.reasoning.parser import ReasoningResult, parse_reasoning
from arforge.reasoning.prompts import build_reasoning_system_prompt


@dataclass
class ReasoningContext:
    """Context passed into the reasoning pipeline."""

    user_input: str
    base_system_prompt: str = ""
    memory_context: str = ""
    learning_context: str = ""
    file_context: str = ""
    task_category: str = "general"
    effort_mode: str = "medium"  # low | medium | high


class ReasoningPipeline:
    """Multi-stage reasoning pipeline that wraps a model adapter.

    Usage:
        pipeline = ReasoningPipeline(adapter)
        result = pipeline.reason(ctx)
        # result.answer — user-facing response
        # result.thinking — chain of thought
        # result.evidence — cited evidence
        # result.to_dict() — full structured output
    """

    def __init__(self, adapter):
        """Initialize with a model adapter (e.g., DeepSeekAdapter)."""
        self._adapter = adapter

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def reason(self, ctx: ReasoningContext) -> ReasoningResult:
        """Run the full reasoning pipeline and return structured result.

        This makes a SINGLE model call. The system prompt instructs the model
        to produce all reasoning stages in one response.
        """
        messages = self._build_messages(ctx)
        raw_response = self._adapter.generate(
            messages,
            max_tokens=self._max_tokens_for_effort(ctx.effort_mode),
            temperature=self._temperature_for_task(ctx.task_category),
        )
        return parse_reasoning(raw_response)

    def reason_stream(self, ctx: ReasoningContext):
        """Stream the reasoning process, yielding chunks as they arrive.

        Yields dicts: {"type": "chunk", "content": "..."} or
                      {"type": "done", "result": ReasoningResult}
        """
        messages = self._build_messages(ctx)
        full_response = ""

        for chunk in self._adapter.stream_generate(
            messages,
            max_tokens=self._max_tokens_for_effort(ctx.effort_mode),
            temperature=self._temperature_for_task(ctx.task_category),
        ):
            text = getattr(chunk, "text", "")
            if text:
                full_response += text
                yield {"type": "chunk", "content": text}

        result = parse_reasoning(full_response)
        yield {"type": "done", "result": result}

    # ------------------------------------------------------------------
    # Message building
    # ------------------------------------------------------------------

    def _build_messages(self, ctx: ReasoningContext) -> list[dict]:
        """Build the messages array for the reasoning call.

        Structure follows Prompt Engineering standards:
          - System message contains role + reasoning instructions + context
          - User message contains the actual task with XML-wrapped input
        """
        system_content = build_reasoning_system_prompt(
            user_input=ctx.user_input,
            base_system_prompt=ctx.base_system_prompt,
            task_category=ctx.task_category,
            memory_context=ctx.memory_context,
            learning_context=ctx.learning_context,
        )

        user_content = self._build_user_content(ctx)

        return [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]

    def _build_user_content(self, ctx: ReasoningContext) -> str:
        """Build the user message with XML-wrapped input data.

        Following the XML separation principle from Prompt Engineering standards:
        each independent input gets its own XML tag pair.
        """
        parts = [f"<task>{ctx.user_input}</task>"]

        if ctx.file_context:
            parts.append(f"<files>{ctx.file_context}</files>")

        if ctx.memory_context:
            parts.append(f"<memory>{ctx.memory_context}</memory>")

        if ctx.learning_context:
            parts.append(f"<learnings>{ctx.learning_context}</learnings>")

        parts.append(
            "\nFollow your reasoning process (understanding → thinking → "
            "evidence → reflection → answer) and output all five XML tags."
        )

        return "\n\n".join(parts)

    # ------------------------------------------------------------------
    # Parameter selection
    # ------------------------------------------------------------------

    @staticmethod
    def _max_tokens_for_effort(effort: str) -> int:
        """Map effort mode to max_tokens for the model call."""
        return {"low": 2048, "medium": 4096, "high": 8192}.get(effort, 4096)

    @staticmethod
    def _temperature_for_task(category: str) -> float:
        """Lower temperature for coding/planning (more deterministic),
        higher for general chat (more creative)."""
        if category in ("fix", "testing"):
            return 0.2
        if category == "planning":
            return 0.3
        return 0.7


# ------------------------------------------------------------------
# Convenience function
# ------------------------------------------------------------------


def quick_reason(adapter, user_input: str, **kwargs) -> ReasoningResult:
    """One-shot reasoning without building a full context object."""
    ctx = ReasoningContext(user_input=user_input, **kwargs)
    pipeline = ReasoningPipeline(adapter)
    return pipeline.reason(ctx)
