"""Learning system hook — bridges the learning layer into the main agent execution path.

Registers hooks that:
  PRE_LLM_CALL 鈫?inject learning context (patterns, fixes, preferences) into messages
  STOP          鈫?record turn outcome (success/failure/fix/feedback) into learning DB
  SESSION_END   鈫?trigger consolidation + dreaming (async, best-effort)
"""

from __future__ import annotations

import logging

from arforge.core.hooks import HookContext, HookDecision, HookEvent, get_hook_manager

logger = logging.getLogger(__name__)


def _inject_learning_ctx(ctx: HookContext) -> HookDecision:
    """PRE_LLM_CALL: inject learned patterns as system-level context."""
    try:
        from arforge.learning_engine import get_injections as build_injections

        user_input = ""
        if ctx.messages:
            for m in reversed(ctx.messages):
                if isinstance(m, dict) and m.get("role") == "user":
                    user_input = m.get("content", "")
                    break

        if not _LEARNING_HOOKS_ACTIVE:
            return HookDecision.proceed()
        if not user_input:
            return HookDecision.proceed()

        injection_text = build_injections(user_input, "agentic")
        if not injection_text:
            return HookDecision.proceed()

        # Cache-preservation: insert learning context as a separate system
        # message AFTER the first system message, so the stable system prompt
        # prefix never changes and DeepSeek prompt cache stays warm.
        new_messages = list(ctx.messages or [])
        # Find first system message position
        sys_idx = -1
        for i, msg in enumerate(new_messages):
            if isinstance(msg, dict) and msg.get("role") == "system":
                sys_idx = i
                break
        # Remove any previously injected blocks after the system message
        # (memory, learning, key_facts, or summary markers)
        _INJECTION_PREFIXES = ("## Relevant Memories", "## Learned Patterns",
                             "## Learning System Context",
                             "【关键事实】", "【历史摘要】")
        if sys_idx >= 0:
            for offset in range(min(4, len(new_messages) - sys_idx - 1), 0, -1):
                check_msg = new_messages[sys_idx + offset]
                if isinstance(check_msg, dict):
                    content = str(check_msg.get("content", ""))
                    if any(content.startswith(p) for p in _INJECTION_PREFIXES):
                        del new_messages[sys_idx + offset]
        # Insert fresh learning block right after system + memory
        if sys_idx >= 0:
            new_messages.insert(sys_idx + 1, {"role": "system", "content": injection_text})
        else:
            new_messages.insert(0, {"role": "system", "content": injection_text})
        return HookDecision.modify(new_messages=new_messages)
    except Exception:
        logger.debug("Learning injection failed (non-fatal)", exc_info=True)
        return HookDecision.proceed()


def _record_turn_outcome(ctx: HookContext) -> HookDecision:
    """STOP: record the completed turn as a learning outcome."""
    try:
        if not _LEARNING_HOOKS_ACTIVE:
            return HookDecision.proceed()
        from arforge.learning_engine import record_turn

        user_input = ctx.metadata.get("task", "")
        has_error = ctx.metadata.get("has_error", False)
        error_msg = ctx.metadata.get("error_message", "")
        error_type = ctx.metadata.get("error_type", "")
        steps = ctx.metadata.get("steps", 0)
        tools = ctx.metadata.get("tools_used", [])

        record_turn(
            user_input=user_input,
            assistant_response=ctx.metadata.get("answer", ""),
            route_type=ctx.metadata.get("route_type", "agentic"),
            success=not has_error,
            intent=ctx.metadata.get("intent", "general"),
            tools=tools,
            error_message=error_msg,
            error_type=error_type,
            feedback=ctx.metadata.get("user_feedback", ""),
            injected_context_size=ctx.metadata.get("injected_context_size", 0),
            steps=steps,
        )
    except Exception:
        logger.debug("Learning record failed (non-fatal)", exc_info=True)
    return HookDecision.proceed()


# 3.3: POST_LLM_CALL counting hook for periodic consolidation
_LLM_CALL_COUNT = 0
_CONSOLIDATE_EVERY_N = 20
_CONSOLIDATE_LOCK = None  # lazy-init threading.Lock
_LAST_CONSOLIDATE_TIME = 0.0


def _get_consolidate_lock():
    global _CONSOLIDATE_LOCK
    if _CONSOLIDATE_LOCK is None:
        import threading
        _CONSOLIDATE_LOCK = threading.Lock()
    return _CONSOLIDATE_LOCK


def _llm_call_counter(ctx) -> HookDecision:
    """POST_LLM_CALL observer: count calls and trigger periodic consolidation."""
    global _LLM_CALL_COUNT, _LAST_CONSOLIDATE_TIME
    import time
    import threading

    _LLM_CALL_COUNT += 1

    if _LLM_CALL_COUNT >= _CONSOLIDATE_EVERY_N:
        _LLM_CALL_COUNT = 0
        # Trigger consolidation in a background thread (non-blocking)
        def _bg_consolidate():
            lock = _get_consolidate_lock()
            if not lock.acquire(blocking=False):
                return  # Already consolidating
            try:
                from arforge.learning_engine import consolidate, reflect_recent
                import config
                consolidate()
                use_llm = getattr(config, "LLM_REFLECT_ENABLED", False)
                reflect_recent(use_llm=use_llm)
                global _LAST_CONSOLIDATE_TIME
                _LAST_CONSOLIDATE_TIME = time.time()
            except Exception:
                pass
            finally:
                lock.release()

        t = threading.Thread(target=_bg_consolidate, daemon=True, name="bg-consolidate")
        t.start()

    return HookDecision.proceed()


def _on_session_end(ctx: HookContext) -> HookDecision:
    """SESSION_END: trigger consolidation + dreaming (best-effort)."""
    try:
        if not _LEARNING_HOOKS_ACTIVE:
            return HookDecision.proceed()
        from arforge.learning_engine import consolidate, dream, reflect_recent

        consolidate()
        dream()
        import config
        if getattr(config, "LLM_REFLECT_ENABLED", False):
            reflect_recent(use_llm=True)
    except Exception:
        logger.debug("Post-session learning failed (non-fatal)", exc_info=True)
    return HookDecision.proceed()


def install_learning_hooks() -> None:
    """Register learning hooks into the global hook manager.

    Safe to call multiple times (idempotent — checks existing registrations).
    """
    mgr = get_hook_manager()
    # Idempotent: only register if not already present
    if "learning_inject" in mgr.handler_names(HookEvent.PRE_LLM_CALL):
        return
    mgr.register(HookEvent.PRE_LLM_CALL, _inject_learning_ctx, priority=90, name="learning_inject")
    # 3.3: POST_LLM_CALL counter triggers periodic consolidation every 20 calls
    mgr.register(HookEvent.POST_LLM_CALL, _llm_call_counter, priority=200, name="learning_llm_counter")
    mgr.register(HookEvent.STOP, _record_turn_outcome, priority=200, name="learning_record")
    mgr.register(HookEvent.SESSION_END, _on_session_end, priority=200, name="learning_consolidate")
    logger.info("Learning hooks installed: inject/counter/record/consolidate")


# ----------------------------------------------------------------
# Quick toggle
# ----------------------------------------------------------------

_LEARNING_HOOKS_ACTIVE = True


def disable_learning_hooks() -> None:
    """Disable learning hooks without unregistering (set global flag)."""
    global _LEARNING_HOOKS_ACTIVE
    _LEARNING_HOOKS_ACTIVE = False


def enable_learning_hooks() -> None:
    """Re-enable learning hooks."""
    global _LEARNING_HOOKS_ACTIVE
    _LEARNING_HOOKS_ACTIVE = True
