# -*- coding: utf-8 -*-
"""Hook integration tests — prove memory hooks fire during agent execution.

The learning hook was retired with the Python evolution runtime; the remaining
governed evolution path is native TypeScript (packages/core/src/evolution).
"""

from __future__ import annotations

import pytest

from arforge.core.hooks import (
    HookContext,
    HookDecision,
    HookEvent,
    get_hook_manager,
    reset_hook_manager,
)


@pytest.fixture(autouse=True)
def _reset():
    reset_hook_manager()
    yield
    reset_hook_manager()


@pytest.fixture
def ctx():
    return HookContext(
        event=HookEvent.PRE_LLM_CALL,
        messages=[
            {"role": "user", "content": "Fix the import error in main.py"},
            {"role": "assistant", "content": "I fixed it."},
        ],
        metadata={
            "task": "Fix import",
            "has_error": False,
            "steps": 3,
            "tools_used": ["read_file"],
            "answer": "Fixed",
            "route_type": "agentic",
            "intent": "bug_fix",
        },
    )


class TestHookRegistration:
    def test_memory_hooks_register(self):
        from arforge.core.memory_hook import install_memory_hooks
        install_memory_hooks()
        mgr = get_hook_manager()
        assert mgr.handler_count(HookEvent.POST_LLM_CALL) >= 1
        assert mgr.handler_count(HookEvent.PRE_LLM_CALL) >= 1
        assert mgr.handler_count(HookEvent.SESSION_END) >= 1

    def test_hooks_idempotent(self):
        from arforge.core.memory_hook import install_memory_hooks
        for _ in range(3):
            install_memory_hooks()
        mgr = get_hook_manager()
        assert mgr.handler_count(HookEvent.PRE_LLM_CALL) == 1
        assert mgr.handler_count(HookEvent.SESSION_END) == 1


class TestHookExecution:
    def test_post_llm_fires(self, ctx):
        from arforge.core.memory_hook import install_memory_hooks
        install_memory_hooks()
        ctx.event = HookEvent.POST_LLM_CALL
        decision = get_hook_manager().fire(ctx)
        assert isinstance(decision, HookDecision)

    def test_pre_llm_fires(self, ctx):
        from arforge.core.memory_hook import install_memory_hooks
        install_memory_hooks()
        ctx.event = HookEvent.PRE_LLM_CALL
        decision = get_hook_manager().fire(ctx)
        assert isinstance(decision, HookDecision)

    def test_session_end_fires(self):
        from arforge.core.memory_hook import install_memory_hooks
        install_memory_hooks()
        end_ctx = HookContext(event=HookEvent.SESSION_END, messages=[], metadata={})
        decision = get_hook_manager().fire(end_ctx)
        assert isinstance(decision, HookDecision)

    def test_empty_context_safe(self):
        from arforge.core.memory_hook import install_memory_hooks
        install_memory_hooks()
        mgr = get_hook_manager()
        for evt in (HookEvent.PRE_LLM_CALL, HookEvent.POST_LLM_CALL, HookEvent.SESSION_END):
            empty = HookContext(event=evt, messages=[], metadata={})
            mgr.fire(empty)


class TestLearningMemoryBridge:
    def test_bridge_imports(self):
        from arforge.core.learning_memory_bridge import promote_memories_to_patterns, get_bridge_stats
        assert callable(promote_memories_to_patterns)
        assert callable(get_bridge_stats)

    def test_bridge_stats(self):
        from arforge.core.learning_memory_bridge import get_bridge_stats
        stats = get_bridge_stats()
        for key in ("total_memories", "high_quality_memories", "auto_promoted_patterns"):
            assert key in stats

    def test_bridge_dry_run(self):
        from arforge.core.learning_memory_bridge import promote_memories_to_patterns
        result = promote_memories_to_patterns(dry_run=True)
        assert result["dry_run"] is True
        assert "promoted" in result
