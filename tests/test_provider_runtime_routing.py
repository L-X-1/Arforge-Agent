"""Provider-routing contracts for optional planning, coordination, and learning paths."""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace


class _Runtime:
    def __init__(self, adapter):
        self.adapter = adapter

    def create_active_adapter(self):
        return self.adapter


def test_quick_plan_uses_the_active_runtime_adapter(monkeypatch):
    from arforge.planning import planner

    expected_adapter = object()
    seen = {}

    def fake_quick_plan(task, model=None):
        seen["task"] = task
        seen["adapter"] = model
        return "planned"

    monkeypatch.setattr(
        "arforge.product.model_config_runtime.get_model_config",
        lambda: _Runtime(expected_adapter),
    )
    monkeypatch.setattr(planner, "quick_plan", fake_quick_plan)

    assert planner.quick_plan_with_model("prepare a plan") == "planned"
    assert seen == {"task": "prepare a plan", "adapter": expected_adapter}


def test_master_fallback_uses_the_active_runtime_adapter(monkeypatch):
    from arforge.multiagent.master_agent import MasterAgent

    calls = []

    class Adapter:
        def generate(self, messages):
            calls.append(messages)
            return "active-provider-result"

    monkeypatch.setattr(
        "arforge.product.model_config_runtime.get_model_config",
        lambda: _Runtime(Adapter()),
    )

    assert MasterAgent._fallback_chat("handle this") == "active-provider-result"
    assert calls == [[{"role": "user", "content": "handle this"}]]


def test_learning_reflection_uses_the_active_runtime_adapter(monkeypatch):
    from arforge.learning_engine import DreamingEngine

    expected_adapter = object()
    seen = {}

    class Query:
        def filter(self, *_args):
            return self

        def order_by(self, *_args):
            return self

        def limit(self, *_args):
            return self

        def all(self):
            return [SimpleNamespace(error_type="TEST", error_message="failure", user_input="task")]

    class Session:
        def query(self, *_args):
            return Query()

    @contextmanager
    def fake_session_factory():
        yield Session()

    def fake_structured(adapter, *_args, **_kwargs):
        seen["adapter"] = adapter
        return None

    engine = DreamingEngine.__new__(DreamingEngine)
    engine._sf = fake_session_factory
    engine.run_once = lambda: {"insights": [], "suggestions": []}
    monkeypatch.setattr(
        "arforge.product.model_config_runtime.get_model_config",
        lambda: _Runtime(expected_adapter),
    )
    monkeypatch.setattr("arforge.models.structured.generate_structured", fake_structured)

    assert engine.reflect(use_llm=True) == []
    assert seen["adapter"] is expected_adapter


def test_onboarding_constructs_the_adapter_after_temporary_credentials(monkeypatch):
    import arforge.onboarding as onboarding

    seen = {}

    class Spinner:
        def __init__(self, *_args):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    class Adapter:
        def __init__(self):
            import os

            seen["key"] = os.environ.get("DEEPSEEK_API_KEY")
            seen["model"] = os.environ.get("DEEPSEEK_MODEL")

        def generate(self, _messages, **_kwargs):
            return "ok"

    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_MODEL", raising=False)
    monkeypatch.setattr("arforge.cli_ui.Spinner", Spinner)
    monkeypatch.setattr("arforge.cli_ui.ok", lambda value: value)
    monkeypatch.setattr("arforge.cli_ui.error", lambda value: value)
    monkeypatch.setattr("arforge.cli_ui.warn", lambda value: value)
    monkeypatch.setattr("arforge.models.deepseek_adapter.DeepSeekAdapter", Adapter)

    assert onboarding._step_test("en", "temporary-key", "temporary-model") is True
    assert seen == {"key": "temporary-key", "model": "temporary-model"}
