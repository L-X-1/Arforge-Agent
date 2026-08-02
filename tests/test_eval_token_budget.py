from __future__ import annotations

from types import SimpleNamespace

import pytest

from arforge.eval.runner import EvalTask, default_runner


class _Adapter:
    model_name = "fake-model"

    def __init__(self, *, total_tokens: int) -> None:
        self.total_tokens = total_tokens
        self.max_tokens_seen: int | None = None

    def generate_with_tools(self, _messages, *, tools, max_tokens=None, **_kwargs):
        assert tools is None
        self.max_tokens_seen = max_tokens
        return SimpleNamespace(
            content="answer",
            usage={"total_tokens": self.total_tokens},
        )


class _Runtime:
    def __init__(self, adapter: _Adapter) -> None:
        self.adapter = adapter

    def create_active_adapter(self):
        return self.adapter


def _patch_runtime(monkeypatch, adapter: _Adapter) -> None:
    import arforge.product.model_config_runtime as model_runtime
    import arforge.tools as tools

    monkeypatch.setattr(model_runtime, "get_model_config", lambda: _Runtime(adapter))
    monkeypatch.setattr(tools, "load_builtin_tools", lambda: {})


def test_default_eval_runner_fails_closed_after_token_budget_overrun(
    tmp_path, monkeypatch
):
    adapter = _Adapter(total_tokens=1001)
    _patch_runtime(monkeypatch, adapter)

    result = default_runner()(
        EvalTask("budget-overrun", "answer", judge="rubric", token_budget=1000),
        tmp_path,
    )

    assert result.passed is False
    assert result.tokens == 1001
    assert result.token_budget == 1000
    assert result.error == "eval token budget exceeded (1001/1000)"
    assert result.incomplete_report == {
        "stop_reason": "token_budget_exceeded",
        "tokens_used": 1001,
        "token_budget": 1000,
    }


def test_default_eval_runner_uses_positive_environment_budget_and_caps_output(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ARFORGE_EVAL_TOKEN_BUDGET", "500")
    adapter = _Adapter(total_tokens=10)
    _patch_runtime(monkeypatch, adapter)

    result = default_runner()(
        EvalTask("budget-ok", "answer", judge="rubric"),
        tmp_path,
    )

    assert result.passed is True
    assert result.token_budget == 500
    assert adapter.max_tokens_seen is not None
    assert 0 < adapter.max_tokens_seen < 500


def test_eval_task_rejects_non_positive_explicit_token_budget():
    with pytest.raises(ValueError, match="token_budget must be positive"):
        EvalTask("invalid-budget", "answer", token_budget=0)
