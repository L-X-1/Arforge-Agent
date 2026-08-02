"""Test that learning/memory hooks activate correctly even when other hooks
share the same HookEvent (P0 regression test for learning_hook idempotency bug).

Root cause: learning_hook and memory_hook used handler_count(event) > 0
for idempotency, but compaction (priority=50) registers on PRE_LLM_CALL first,
blocking learning hooks from ever registering.
Fix: use named check via handler_names(event) instead.
"""

from __future__ import annotations


from arforge.core.hooks import HookEvent, get_hook_manager, HookDecision


def test_learning_hooks_register_with_compaction_present(monkeypatch, tmp_path):
    """scenario: compaction hooks are installed first on PRE_LLM_CALL,
    then install_learning_hooks() must still register its handlers."""
    from arforge.core.compaction import install_compaction_hook
    from arforge.core.learning_hook import install_learning_hooks

    # Reset hook manager to clean state
    mgr = get_hook_manager()
    mgr.clear()

    # Step 1: install compaction (this is what cli.py does first)
    install_compaction_hook()

    # Sanity: compaction should have registered on PRE_LLM_CALL
    pre_names_before = mgr.handler_names(HookEvent.PRE_LLM_CALL)
    assert len(pre_names_before) > 0, "compaction should register on PRE_LLM_CALL"

    # Step 2: install learning hooks (this is what cli.py does second)
    install_learning_hooks()

    # The bug: before the fix, handler_count(PRE_LLM_CALL) > 0 would
    # make install_learning_hooks() return early without registering.
    # After the fix, it should check for "learning_inject" by name.
    pre_names_after = mgr.handler_names(HookEvent.PRE_LLM_CALL)
    assert "learning_inject" in pre_names_after, (
        "learning_inject must be registered on PRE_LLM_CALL even when compaction "
        "is already present on the same event"
    )

    # All three learning hooks should be present
    all_names = mgr.handler_names()  # all events
    assert "learning_inject" in all_names
    assert "learning_record" in all_names
    assert "learning_consolidate" in all_names


def test_memory_hooks_register_idempotent_by_name(monkeypatch, tmp_path):
    """Memory hooks must also use named idempotency check, not handler_count."""
    from arforge.core.memory_hook import install_memory_hooks

    mgr = get_hook_manager()
    mgr.clear()

    # Install twice - should be idempotent
    install_memory_hooks()
    post_names = mgr.handler_names(HookEvent.POST_LLM_CALL)
    assert "memory_extract" in post_names, "memory_extract must be registered"

    # Second call should be a no-op
    install_memory_hooks()
    post_names_2 = mgr.handler_names(HookEvent.POST_LLM_CALL)
    assert post_names_2 == post_names, "second install must be idempotent"

    all_names = mgr.handler_names()
    assert "memory_inject" in all_names
    assert "memory_index_rebuild" in all_names


def test_hooks_handler_names_api():
    """Verify the new handler_names() API works correctly."""
    mgr = get_hook_manager()
    mgr.clear()

    def dummy(ctx):
        return HookDecision.proceed()

    mgr.register(HookEvent.PRE_LLM_CALL, dummy, priority=50, name="test_a")
    mgr.register(HookEvent.PRE_LLM_CALL, dummy, priority=90, name="test_b")
    mgr.register(HookEvent.STOP, dummy, priority=200, name="test_c")

    # By event
    pre_names = mgr.handler_names(HookEvent.PRE_LLM_CALL)
    assert pre_names == {"test_a", "test_b"}

    stop_names = mgr.handler_names(HookEvent.STOP)
    assert stop_names == {"test_c"}

    # All
    all_names = mgr.handler_names()
    assert all_names == {"test_a", "test_b", "test_c"}

    # handler_count should still work
    assert mgr.handler_count(HookEvent.PRE_LLM_CALL) == 2
    assert mgr.handler_count() == 3
