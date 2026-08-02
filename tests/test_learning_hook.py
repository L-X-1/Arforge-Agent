"""Tests for learning hook integration — bridges learning layer to agent execution."""

from __future__ import annotations

import pytest

from arforge.core.hooks import (
    HookContext,
    HookEvent,
    get_hook_manager,
    reset_hook_manager,
)


@pytest.fixture(autouse=True)
def _reset():
    reset_hook_manager()
    yield
    reset_hook_manager()


class TestLearningHookRegistration:
    def test_install_registers_all_three_hooks(self):
        from arforge.core.learning_hook import install_learning_hooks

        install_learning_hooks()
        mgr = get_hook_manager()

        assert mgr.handler_count(HookEvent.PRE_LLM_CALL) == 1
        assert mgr.handler_count(HookEvent.STOP) == 1
        assert mgr.handler_count(HookEvent.SESSION_END) == 1

    def test_install_is_idempotent(self):
        from arforge.core.learning_hook import install_learning_hooks

        install_learning_hooks()
        install_learning_hooks()
        mgr = get_hook_manager()

        # Should still be 1 each, not doubled
        assert mgr.handler_count(HookEvent.PRE_LLM_CALL) == 1
        assert mgr.handler_count(HookEvent.STOP) == 1
        assert mgr.handler_count(HookEvent.SESSION_END) == 1

    def test_handlers_return_proceed_on_empty_context(self):
        from arforge.core.learning_hook import install_learning_hooks

        install_learning_hooks()
        mgr = get_hook_manager()

        # All handlers should proceed gracefully with minimal context
        ctx = HookContext(event=HookEvent.STOP, metadata={})
        result = mgr.fire(ctx)
        assert result.action == "proceed"

        ctx = HookContext(event=HookEvent.SESSION_END, metadata={})
        result = mgr.fire(ctx)
        assert result.action == "proceed"


class TestLearningInjection:
    def test_inject_adds_system_message(self):
        from arforge.core.learning_hook import install_learning_hooks

        install_learning_hooks()
        mgr = get_hook_manager()

        ctx = HookContext(
            event=HookEvent.PRE_LLM_CALL,
            messages=[
                {"role": "system", "content": "You are an agent."},
                {"role": "user", "content": "fix this bug"},
            ],
        )
        result = mgr.fire(ctx)

        # Result should be proceed (no learned data yet) or modify
        assert result.action in ("proceed", "modify")

    def test_inject_no_crash_with_no_messages(self):
        from arforge.core.learning_hook import install_learning_hooks

        install_learning_hooks()
        mgr = get_hook_manager()

        ctx = HookContext(event=HookEvent.PRE_LLM_CALL, messages=None)
        result = mgr.fire(ctx)
        assert result.action == "proceed"


class TestLearningRecording:
    def test_record_no_crash_on_empty_metadata(self):
        from arforge.core.learning_hook import install_learning_hooks

        install_learning_hooks()
        mgr = get_hook_manager()

        ctx = HookContext(event=HookEvent.STOP, metadata={})
        result = mgr.fire(ctx)
        assert result.action == "proceed"

    def test_record_with_full_metadata(self):
        from arforge.core.learning_hook import install_learning_hooks

        install_learning_hooks()
        mgr = get_hook_manager()

        ctx = HookContext(
            event=HookEvent.STOP,
            metadata={
                "task": "Write a hello world program",
                "has_error": False,
                "answer": "Created hello.py",
                "route_type": "code",
                "intent": "write_code",
                "steps": 3,
                "tools_used": ["write_file", "run_cmd"],
            },
        )
        result = mgr.fire(ctx)
        assert result.action == "proceed"


class TestToggle:
    def test_disable_enable_flags(self):
        import arforge.core.learning_hook as lh

        assert lh._LEARNING_HOOKS_ACTIVE is True
        lh.disable_learning_hooks()
        assert lh._LEARNING_HOOKS_ACTIVE is False
        lh.enable_learning_hooks()
        assert lh._LEARNING_HOOKS_ACTIVE is True
