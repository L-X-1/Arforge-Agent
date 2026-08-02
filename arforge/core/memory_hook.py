"""Memory system hook — auto-extracts memories and injects semantic context.

Registers hooks that:
  POST_LLM_CALL  → auto-extract memories from conversation turns (8 heuristic rules)
  PRE_LLM_CALL   → inject relevant semantic memories as system-level context
  SESSION_END    → rebuild semantic index for fresh next-session search
"""

from __future__ import annotations

import logging
from pathlib import Path

from arforge.core.hooks import HookContext, HookDecision, HookEvent, get_hook_manager

logger = logging.getLogger(__name__)


def _auto_extract_memories(ctx: HookContext) -> HookDecision:
    """POST_LLM_CALL: apply 8 heuristic rules to extract long-term memories from the turn."""
    try:
        if not _MEMORY_HOOKS_ACTIVE:
            return HookDecision.proceed()

        from arforge.auto_memory import extract_memories_from_turn
        from arforge.workspace_context import current_workspace

        user_msg = ctx.metadata.get("user_input", "")
        assistant_msg = ctx.metadata.get("assistant_response", "")
        if not user_msg:
            # Try to get from last messages
            msgs = ctx.messages or []
            for m in reversed(msgs):
                if isinstance(m, dict):
                    if m.get("role") == "user" and not user_msg:
                        user_msg = m.get("content", "")
                    if m.get("role") == "assistant" and not assistant_msg:
                        assistant_msg = m.get("content", "")

        if not user_msg:
            return HookDecision.proceed()

        extracted = extract_memories_from_turn(
            user_input=user_msg,
            assistant_response=assistant_msg,
            auto_save=True,
            workspace_path=str(current_workspace(Path.cwd())),
        )

        if extracted:
            logger.debug("Auto-extracted %d memories from turn", len(extracted))
    except Exception:
        logger.debug("Auto memory extraction failed (non-fatal)", exc_info=True)
    return HookDecision.proceed()


def _inject_relevant_memories(ctx: HookContext) -> HookDecision:
    """PRE_LLM_CALL: inject semantically relevant memories into system context."""
    try:
        if not _MEMORY_HOOKS_ACTIVE:
            return HookDecision.proceed()

        # Internal recovery/verification prompts also use role=user. Recall
        # against the stable original task when the agent loop provides it.
        user_input = str((ctx.metadata or {}).get("task") or (ctx.metadata or {}).get("user_input") or "")
        if ctx.messages:
            if not user_input:
                for m in reversed(ctx.messages):
                    if isinstance(m, dict) and m.get("role") == "user":
                        user_input = m.get("content", "")
                        break

        if not user_input or len(user_input) < 3:
            return HookDecision.proceed()

        # ArforgeAgent already performs the same scoped recall for its system
        # prompt. Do not inject a second copy into agentic turns.
        if any(
            isinstance(message, dict)
            and message.get("role") == "system"
            and ("## Relevant Memory" in str(message.get("content", "")) or "<memory_data>" in str(message.get("content", "")))
            for message in (ctx.messages or [])
        ):
            return HookDecision.proceed()

        from arforge.auto_memory import workspace_memory_scope
        from arforge.semantic_memory import semantic_search_memories
        from arforge.workspace_context import current_workspace

        project_id, workspace_path = workspace_memory_scope(current_workspace(Path.cwd()))
        report = semantic_search_memories(
            user_input,
            top_k=5,
            min_score=0.05,
            project_id=project_id,
            workspace_path=workspace_path,
            limit=500,
        )
        results = report.get("items", []) if isinstance(report, dict) else report
        if not results:
            return HookDecision.proceed()

        from arforge.core.memory_context import render_untrusted_memories

        rendered = render_untrusted_memories(results, limit=5)
        if not rendered:
            return HookDecision.proceed()
        memory_block = "## Relevant Memories\n" + rendered

        # Cache-preservation: insert memory as a separate system message
        # AFTER the first system message, so the stable system prompt prefix
        # never changes and DeepSeek prompt cache stays warm across turns.
        new_messages = list(ctx.messages or [])
        # Find first system message position
        sys_idx = -1
        for i, msg in enumerate(new_messages):
            if isinstance(msg, dict) and msg.get("role") == "system":
                sys_idx = i
                break
        # Replace only this hook's prior recall block. Compaction summaries,
        # key facts, and learning context belong to independent subsystems and
        # must survive subsequent turns.
        new_messages = [
            message
            for index, message in enumerate(new_messages)
            if not (
                index != sys_idx
                and isinstance(message, dict)
                and message.get("role") == "system"
                and str(message.get("content", "")).startswith("## Relevant Memories")
            )
        ]
        if sys_idx >= 0:
            sys_idx = next(
                (i for i, message in enumerate(new_messages) if isinstance(message, dict) and message.get("role") == "system"),
                -1,
            )
        # Insert fresh memory block right after the system message
        if sys_idx >= 0:
            new_messages.insert(sys_idx + 1, {"role": "system", "content": memory_block})
        else:
            new_messages.insert(0, {"role": "system", "content": memory_block})
        return HookDecision.modify(new_messages=new_messages)
    except Exception:
        logger.debug("Semantic memory injection failed (non-fatal)", exc_info=True)
        return HookDecision.proceed()


def _rebuild_index_on_session_end(ctx: HookContext) -> HookDecision:
    """SESSION_END: rebuild semantic index so next session searches fresh data."""
    try:
        if not _MEMORY_HOOKS_ACTIVE:
            return HookDecision.proceed()
        from arforge.semantic_memory import rebuild_semantic_index
        rebuild_semantic_index(force=True)
    except Exception:
        logger.debug("Semantic index rebuild failed (non-fatal)", exc_info=True)

    # Auto-promote high-quality memories to learning patterns
    try:
        if _MEMORY_HOOKS_ACTIVE:
            from arforge.core.learning_memory_bridge import promote_memories_to_patterns
            result = promote_memories_to_patterns(dry_run=False)
            if result["promoted"] > 0:
                logger.info("Memory-learning bridge: promoted %d memories to patterns", result["promoted"])
    except Exception:
        logger.debug("Memory-learning bridge promotion failed (non-fatal)", exc_info=True)

    return HookDecision.proceed()


def install_memory_hooks() -> None:
    """Register memory hooks into the global hook manager.

    Safe to call multiple times (idempotent).
    """
    mgr = get_hook_manager()
    # Idempotent: check POST_LLM_CALL which only memory hooks register on
    if "memory_extract" in mgr.handler_names(HookEvent.POST_LLM_CALL):
        return

    mgr.register(HookEvent.POST_LLM_CALL, _auto_extract_memories, priority=100, name="memory_extract")
    mgr.register(HookEvent.PRE_LLM_CALL, _inject_relevant_memories, priority=80, name="memory_inject")
    mgr.register(HookEvent.SESSION_END, _rebuild_index_on_session_end, priority=150, name="memory_index_rebuild")
    logger.info("Memory hooks installed: extract/inject/index_rebuild")


# ----------------------------------------------------------------
# Quick toggle
# ----------------------------------------------------------------

_MEMORY_HOOKS_ACTIVE = True


def disable_memory_hooks() -> None:
    """Disable memory hooks without unregistering."""
    global _MEMORY_HOOKS_ACTIVE
    _MEMORY_HOOKS_ACTIVE = False


def enable_memory_hooks() -> None:
    """Re-enable memory hooks."""
    global _MEMORY_HOOKS_ACTIVE
    _MEMORY_HOOKS_ACTIVE = True
