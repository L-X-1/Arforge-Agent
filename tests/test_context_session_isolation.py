"""Regression coverage for execution-local compacted context state."""

from __future__ import annotations

import threading

import pytest

from arforge.core import compaction
from arforge.core.change_tracker import get_change_tracker
from arforge.core.compaction import (
    auto_compact_hook,
    extract_key_facts,
    request_force_compact,
)
from arforge.core.hooks import HookContext, HookEvent, reset_hook_manager
from arforge.workspace_context import execution_scope


class _SummarizerAdapter:
    model_name = "deepseek-v4-flash"

    def generate(self, messages, max_tokens=None, temperature=None, response_format=None):
        return "summary"


def _history() -> list[dict]:
    messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "task"},
    ]
    messages.extend(
        {"role": "assistant", "content": f"step {index}"}
        for index in range(12)
    )
    return messages


def _pre_llm_context(step: int) -> HookContext:
    return HookContext(
        HookEvent.PRE_LLM_CALL,
        messages=_history(),
        metadata={"adapter": _SummarizerAdapter(), "step": step},
    )


@pytest.fixture(autouse=True)
def _isolate_hooks():
    reset_hook_manager()
    yield
    reset_hook_manager()


def test_compaction_interval_isolated_between_execution_sessions(monkeypatch):
    monkeypatch.setattr(compaction, "needs_compaction", lambda _messages, _model: True)

    with execution_scope("session-a"):
        first = auto_compact_hook(_pre_llm_context(step=20))
        assert first is not None and first.action == "modify"

    with execution_scope("session-b"):
        second = auto_compact_hook(_pre_llm_context(step=1))

    assert second is not None and second.action == "modify"


def test_forced_compaction_does_not_cross_execution_sessions(monkeypatch):
    monkeypatch.setattr(compaction, "needs_compaction", lambda _messages, _model: False)

    with execution_scope("session-a"):
        assert auto_compact_hook(_pre_llm_context(step=1)) is None
        request_force_compact()

    with execution_scope("session-b"):
        decision = auto_compact_hook(_pre_llm_context(step=1))

    assert decision is None


def test_changed_file_facts_are_scoped_to_the_active_session():
    with execution_scope("session-a"):
        get_change_tracker().record("tenant-a-secret.py")
        first_facts = extract_key_facts([])

    with execution_scope("session-b"):
        second_facts = extract_key_facts([])
        get_change_tracker().record("tenant-b.py")
        own_facts = extract_key_facts([])

    assert "tenant-a-secret.py" in "\n".join(first_facts)
    assert "tenant-a-secret.py" not in "\n".join(second_facts)
    assert "tenant-b.py" in "\n".join(own_facts)


def test_nested_execution_scope_restores_outer_changed_files():
    with execution_scope("session-a"):
        get_change_tracker().record("outer.py")
        with execution_scope("session-b"):
            assert get_change_tracker().is_empty()
            get_change_tracker().record("inner.py")
            assert get_change_tracker().changed() == ["inner.py"]
        assert get_change_tracker().changed() == ["outer.py"]


def test_parallel_sessions_do_not_share_changed_file_facts():
    barrier = threading.Barrier(2)
    facts_by_session: dict[str, list[str]] = {}

    def worker(session_id: str, filename: str) -> None:
        with execution_scope(session_id):
            get_change_tracker().record(filename)
            barrier.wait(timeout=2)
            facts_by_session[session_id] = extract_key_facts([])

    first = threading.Thread(target=worker, args=("session-a", "tenant-a.py"))
    second = threading.Thread(target=worker, args=("session-b", "tenant-b.py"))
    first.start()
    second.start()
    first.join(timeout=3)
    second.join(timeout=3)

    assert not first.is_alive()
    assert not second.is_alive()
    assert "tenant-a.py" in "\n".join(facts_by_session["session-a"])
    assert "tenant-b.py" not in "\n".join(facts_by_session["session-a"])
    assert "tenant-b.py" in "\n".join(facts_by_session["session-b"])
    assert "tenant-a.py" not in "\n".join(facts_by_session["session-b"])
