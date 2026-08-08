"""Ablation eval 框架测试（离线，FakeAdapter 全假，不调用真实模型）。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import arforge.eval.ablation as ablation
import arforge.tools as tools
from arforge.eval.ablation import (
    ablation_history,
    clear_ablation_history,
    create_adapter_for,
    make_bare_runner,
    parse_model_spec,
    run_ablation_eval,
)
from arforge.eval.runner import EvalTask, default_runner
from arforge.product.model_config_runtime import ModelConfigError


def _response(content: str = "answer"):
    return SimpleNamespace(
        content=content,
        usage={"total_tokens": 5},
        tool_calls=[],
        finish_reason="stop",
        provider_content=None,
    )


class FakeAdapter:
    """全假模型 adapter：记录调用次数并返回固定内容。"""

    model_name = "fake-model"

    def __init__(
        self,
        *,
        content: str = "answer",
        judge_json: str = '{"passed": true, "score": 1.0, "reason": "ok"}',
    ) -> None:
        self.content = content
        self.judge_json = judge_json
        self.context_window_tokens = 100_000
        self.generate_with_tools_calls = 0
        self.generate_calls = 0

    def generate_with_tools(
        self, messages, tools=None, max_tokens=None, tool_choice=None, **kwargs
    ):
        self.generate_with_tools_calls += 1
        return _response(self.content)

    def generate(
        self, messages, max_tokens=None, temperature=None, response_format=None, **kwargs
    ):
        self.generate_calls += 1
        return self.judge_json


def _tasks() -> list[EvalTask]:
    """1 个 judge 任务 + 1 个 check 任务（check 闭包返回 False）。"""
    return [
        EvalTask(
            task_id="explain_recursion",
            prompt="Explain what recursion is in programming",
            judge="Correctly explains recursion as a function calling itself with a base case",
            category="architecture_qa",
        ),
        EvalTask(
            task_id="write_hello",
            prompt="Write a file named eval_hello.txt with content HELLO_ARFORGE.",
            check=lambda: False,
        ),
    ]


# ---------------------------------------------------------------------------
# parse_model_spec
# ---------------------------------------------------------------------------

def test_parse_model_spec_provider_only():
    assert parse_model_spec("deepseek") == ("deepseek", "")


def test_parse_model_spec_with_model():
    assert parse_model_spec("openai/gpt-4o-mini") == ("openai", "gpt-4o-mini")
    assert parse_model_spec("anthropic/claude-sonnet-4") == ("anthropic", "claude-sonnet-4")
    assert parse_model_spec(" deepseek / deepseek-v4-pro ") == (
        "deepseek",
        "deepseek-v4-pro",
    )


def test_parse_model_spec_rejects_unknown_provider():
    with pytest.raises(ValueError, match="unsupported provider"):
        parse_model_spec("gemini")
    with pytest.raises(ValueError, match="unsupported provider"):
        parse_model_spec("unknown/whatever")
    with pytest.raises(ValueError):
        parse_model_spec("")


def test_create_adapter_for_unknown_provider_raises():
    with pytest.raises(ModelConfigError):
        create_adapter_for("nonexistent")


# ---------------------------------------------------------------------------
# make_bare_runner
# ---------------------------------------------------------------------------

def test_make_bare_runner_check_task_skips_model():
    adapter = FakeAdapter()
    runner = make_bare_runner(adapter)
    result = runner(EvalTask("w1", "Write a file.", check=lambda: False), None)
    assert result.passed is False
    assert result.error is not None and "bare_unsupported" in result.error
    assert result.tokens == 0
    assert adapter.generate_with_tools_calls == 0


def test_make_bare_runner_verify_task_skips_model():
    adapter = FakeAdapter()
    runner = make_bare_runner(adapter)
    result = runner(EvalTask("v1", "task", verify=lambda ws: True), None)
    assert "bare_unsupported" in (result.error or "")
    assert adapter.generate_with_tools_calls == 0


def test_make_bare_runner_judge_task_generates_once():
    adapter = FakeAdapter()
    runner = make_bare_runner(adapter)
    result = runner(
        EvalTask("j1", "Explain recursion", judge="rubric", category="arch"), None
    )
    assert result.passed is True
    assert result.answer == "answer"
    assert result.tokens == 5
    assert result.steps == 1
    assert adapter.generate_with_tools_calls == 1


def test_default_runner_accepts_adapter():
    runner = default_runner(FakeAdapter())
    assert callable(runner)


# ---------------------------------------------------------------------------
# run_ablation_eval
# ---------------------------------------------------------------------------

def _patch_factory(monkeypatch, factory):
    monkeypatch.setattr(ablation, "create_adapter_for", factory)
    monkeypatch.setattr(tools, "load_builtin_tools", lambda: {})


def test_run_ablation_eval_uplift_and_cross_model(monkeypatch):
    strong = FakeAdapter()
    weak = FakeAdapter(judge_json='{"passed": false, "score": 0.0, "reason": "bad"}')

    def factory(provider, model=""):
        return weak if model == "gpt-4o-mini" else strong

    _patch_factory(monkeypatch, factory)
    result = run_ablation_eval(
        _tasks(),
        model_specs=["deepseek", "openai/gpt-4o-mini"],
        weak_model_spec="openai/gpt-4o-mini",
    )

    assert result["schema_version"] == 1
    assert result["skip_bare"] is False
    assert result["generated_at"]
    assert set(result["models"]) == {"deepseek", "openai/gpt-4o-mini"}

    strong_model = result["models"]["deepseek"]
    assert strong_model["provider"] == "deepseek"
    assert strong_model["enhanced"]["total"] == 2
    assert strong_model["enhanced"]["passed"] == 1
    assert strong_model["enhanced"]["success_rate"] == 0.5
    assert strong_model["enhanced"]["total_tokens"] == 10
    assert strong_model["bare"]["bare_unsupported"] == 1
    assert strong_model["comparable_tasks"] == 1
    assert strong_model["bare_rate_on_comparable"] == 1.0
    assert strong_model["enhanced_rate_on_comparable"] == 1.0
    assert strong_model["uplift"] == 0.0
    assert strong_model["efficiency"]["tokens_per_success"] == 10.0
    assert strong_model["efficiency"]["success_per_cost_cny"] is None

    weak_model = result["models"]["openai/gpt-4o-mini"]
    assert weak_model["enhanced"]["passed"] == 0
    assert weak_model["enhanced_rate_on_comparable"] == 0.0
    assert weak_model["bare_rate_on_comparable"] == 0.0
    assert weak_model["uplift"] == 0.0

    summary = result["summary"]
    assert summary["cross_model_spread"] == pytest.approx(0.5)
    assert summary["cross_model_std"] == pytest.approx(0.25)
    assert summary["best_model"] == "deepseek"
    assert summary["worst_model"] == "openai/gpt-4o-mini"
    assert summary["weak_model_uplift"] == 0.0
    assert "bare_unsupported" in result["note"]


def test_run_ablation_eval_skip_bare(monkeypatch):
    adapter = FakeAdapter()
    _patch_factory(monkeypatch, lambda provider, model="": adapter)
    result = run_ablation_eval(_tasks(), model_specs=["deepseek"], skip_bare=True)

    assert result["skip_bare"] is True
    entry = result["models"]["deepseek"]
    assert "bare" not in entry
    assert entry["uplift"] is None
    assert entry["bare_rate_on_comparable"] is None
    summary = result["summary"]
    assert summary["cross_model_spread"] is None
    assert summary["cross_model_std"] is None
    assert summary["best_model"] is None
    assert summary["worst_model"] is None
    assert "weak_model_uplift" not in summary


def test_run_ablation_eval_weak_model_spec_missing(monkeypatch):
    adapter = FakeAdapter()
    _patch_factory(monkeypatch, lambda provider, model="": adapter)
    result = run_ablation_eval(
        _tasks(),
        model_specs=["deepseek"],
        weak_model_spec="openai/gpt-4o-mini",
    )
    assert "weak_model_uplift" not in result["summary"]


# ---------------------------------------------------------------------------
# history persistence
# ---------------------------------------------------------------------------

def test_ablation_history_roundtrip(monkeypatch):
    adapter = FakeAdapter()
    _patch_factory(monkeypatch, lambda provider, model="": adapter)
    run_ablation_eval(_tasks(), model_specs=["deepseek"])

    history = ablation_history()
    assert len(history) == 1
    row = history[0]
    assert row["ts"]
    assert row["specs"] == ["deepseek"]
    assert row["summary"]["cross_model_spread"] is None
    assert row["models"]["deepseek"]["enhanced_success_rate"] == 0.5


def test_ablation_history_limit(monkeypatch):
    adapter = FakeAdapter()
    _patch_factory(monkeypatch, lambda provider, model="": adapter)
    for _ in range(3):
        run_ablation_eval(_tasks(), model_specs=["deepseek"])
    assert len(ablation_history()) == 3
    assert len(ablation_history(limit=2)) == 2
    assert [row["ts"] for row in ablation_history(limit=2)] == [
        row["ts"] for row in ablation_history()[1:]
    ]


def test_clear_ablation_history(monkeypatch):
    adapter = FakeAdapter()
    _patch_factory(monkeypatch, lambda provider, model="": adapter)
    run_ablation_eval(_tasks(), model_specs=["deepseek"])
    assert clear_ablation_history() == 1
    assert ablation_history() == []
    assert clear_ablation_history() == 0
