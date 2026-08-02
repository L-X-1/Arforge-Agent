"""P0-1 模型层验收测试。

覆盖：function calling 解析 / 流式 usage / DeepSeek 缓存命中读取 /
response_format 透传 / 指数退避重试与降级。
用 FakeClient 注入，不依赖真实 API key 或网络。
"""

from types import SimpleNamespace

import pytest

from arforge.models import token_tracker
from arforge.models.deepseek_adapter import (
    DeepSeekAdapter,
    _request_fingerprints,
    _usage_to_dict,
)
from arforge.models.resilience import ModelCallError, RetryPolicy


# --------------------------------------------------------------------------
# Fake provider（模拟 openai client.chat.completions.create）
# --------------------------------------------------------------------------


class _FakeCompletions:
    def __init__(self, outer):
        self.outer = outer

    def create(self, **kwargs):
        self.outer.calls.append(kwargs)
        if self.outer.raise_n > 0:
            self.outer.raise_n -= 1
            raise self.outer.exc
        if kwargs.get("stream"):
            return iter(self.outer.stream_chunks)
        return self.outer.response


class _FakeClient:
    def __init__(self, response=None, stream_chunks=None, raise_n=0, exc=None):
        self.response = response
        self.stream_chunks = stream_chunks or []
        self.raise_n = raise_n
        self.exc = exc or RuntimeError("boom")
        self.calls = []
        self.chat = SimpleNamespace(completions=_FakeCompletions(self))


class APITimeoutError(Exception):
    """类名匹配 resilience 的可重试白名单（模拟 openai.APITimeoutError）。"""


def _adapter(client):
    a = DeepSeekAdapter()
    a.client = client
    # 测试用：0 退避、无 jitter，避免真实 sleep
    a._retry = RetryPolicy(max_retries=3, base_delay=0.0, jitter=False)
    return a


def _usage(prompt=10, completion=5, total=15, hit=8, miss=2):
    return SimpleNamespace(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        prompt_cache_hit_tokens=hit,
        prompt_cache_miss_tokens=miss,
    )


def _msg(content="", tool_calls=None):
    return SimpleNamespace(content=content, tool_calls=tool_calls, reasoning_content=None)


def _resp(message, usage=None, finish_reason="stop"):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason=finish_reason)],
        usage=usage,
    )


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------


def test_generate_with_tools_parses_toolcalls_and_cache():
    tc = SimpleNamespace(
        id="c1",
        function=SimpleNamespace(name="calculate", arguments='{"expression":"2+2"}'),
    )
    client = _FakeClient(response=_resp(_msg("", [tc]), usage=_usage(hit=8), finish_reason="tool_calls"))
    a = _adapter(client)

    resp = a.generate_with_tools([{"role": "user", "content": "2+2?"}], tools=[{"type": "function"}])

    assert resp.finish_reason == "tool_calls"
    assert resp.tool_calls[0].name == "calculate"
    assert resp.tool_calls[0].arguments == '{"expression":"2+2"}'
    assert resp.usage["prompt_cache_hit_tokens"] == 8
    assert "tool_choice" not in client.calls[-1]
    assert client.calls[-1]["tools"] == [{"type": "function"}]
    assert client.calls[-1]["extra_body"] == {"thinking": {"type": "enabled"}}
    assert client.calls[-1]["reasoning_effort"] == "high"


def test_deepseek_thinking_mode_omits_forced_tool_choice():
    client = _FakeClient(response=_resp(_msg("ok"), usage=_usage()))
    adapter = _adapter(client)

    adapter.generate_with_tools(
        [{"role": "user", "content": "run tests"}],
        tools=[{"type": "function", "function": {"name": "run_tests"}}],
        tool_choice={
            "type": "function",
            "function": {"name": "run_tests"},
        },
    )

    assert adapter.supports_forced_tool_choice is False
    assert "tool_choice" not in client.calls[-1]


def test_response_format_passthrough():
    client = _FakeClient(response=_resp(_msg("{}"), usage=_usage()))
    a = _adapter(client)

    a.generate([{"role": "user", "content": "hi"}], response_format={"type": "json_object"})

    assert client.calls[-1]["response_format"] == {"type": "json_object"}


def test_stream_generate_yields_usage_and_sets_stream_options():
    def chunk(content=None, usage=None):
        choices = (
            []
            if content is None
            else [SimpleNamespace(delta=SimpleNamespace(content=content, reasoning_content=None))]
        )
        return SimpleNamespace(choices=choices, usage=usage)

    chunks = [
        chunk("Hel"),
        chunk("lo"),
        chunk(None, usage=_usage(prompt=3, completion=2, total=5, hit=0, miss=3)),
    ]
    client = _FakeClient(stream_chunks=chunks)
    a = _adapter(client)

    out = list(a.stream_generate([{"role": "user", "content": "hi"}]))

    text = "".join(c.text for c in out if c.kind == "content")
    assert text == "Hello"
    usage_chunks = [c for c in out if c.kind == "usage"]
    assert len(usage_chunks) == 1
    assert usage_chunks[0].usage["total_tokens"] == 5
    assert client.calls[-1]["stream_options"] == {"include_usage": True}
    assert client.calls[-1]["stream"] is True
    assert client.calls[-1]["extra_body"] == {"thinking": {"type": "enabled"}}
    assert client.calls[-1]["reasoning_effort"] == "high"


def test_stream_generate_with_tools_parses_toolcalls_and_passthrough():
    def chunk(content=None, tool_calls=None, finish_reason=None, usage=None):
        choices = (
            []
            if content is None and tool_calls is None and finish_reason is None
            else [
                SimpleNamespace(
                    delta=SimpleNamespace(
                        content=content,
                        reasoning_content=None,
                        tool_calls=tool_calls or [],
                    ),
                    finish_reason=finish_reason,
                )
            ]
        )
        return SimpleNamespace(choices=choices, usage=usage)

    chunks = [
        chunk("Let me check. "),
        chunk(
            tool_calls=[
                SimpleNamespace(
                    index=0,
                    id="c1",
                    function=SimpleNamespace(name="calculate", arguments='{"expression"'),
                )
            ]
        ),
        chunk(
            tool_calls=[
                SimpleNamespace(
                    index=0,
                    id=None,
                    function=SimpleNamespace(name=None, arguments=':"2+2"}'),
                )
            ],
            finish_reason="tool_calls",
        ),
        chunk(None, usage=_usage(prompt=4, completion=3, total=7, hit=1, miss=3)),
    ]
    client = _FakeClient(stream_chunks=chunks)
    a = _adapter(client)
    tokens = []

    resp = a.stream_generate_with_tools(
        [{"role": "user", "content": "2+2?"}],
        tools=[{"type": "function"}],
        response_format={"type": "json_object"},
        on_content=tokens.append,
    )

    assert tokens == ["Let me check. "]
    assert resp.content == "Let me check. "
    assert resp.finish_reason == "tool_calls"
    assert resp.tool_calls[0].id == "c1"
    assert resp.tool_calls[0].name == "calculate"
    assert resp.tool_calls[0].arguments == '{"expression":"2+2"}'
    assert resp.usage["total_tokens"] == 7
    assert client.calls[-1]["stream_options"] == {"include_usage": True}
    assert client.calls[-1]["response_format"] == {"type": "json_object"}


def test_retry_then_success_on_retryable_error():
    client = _FakeClient(
        response=_resp(_msg("ok"), usage=_usage()),
        raise_n=2,
        exc=APITimeoutError("timeout"),
    )
    a = _adapter(client)

    result = a.generate([{"role": "user", "content": "hi"}])

    assert result == "ok"
    assert len(client.calls) == 3  # 失败2次 + 成功1次


def test_retry_gives_up_and_raises_model_call_error():
    client = _FakeClient(response=_resp(_msg("ok")), raise_n=99, exc=APITimeoutError("timeout"))
    a = _adapter(client)

    with pytest.raises(ModelCallError):
        a.generate([{"role": "user", "content": "hi"}])

    assert len(client.calls) == 4  # max_retries=3 → 共4次尝试


def test_non_retryable_error_not_retried():
    client = _FakeClient(response=_resp(_msg("ok")), raise_n=99, exc=ValueError("bad arg"))
    a = _adapter(client)

    with pytest.raises(ModelCallError):
        a.generate([{"role": "user", "content": "hi"}])

    assert len(client.calls) == 1  # 不可重试 → 只1次


def test_usage_to_dict_parses_openai_style_cached_tokens():
    usage = SimpleNamespace(
        prompt_tokens=100,
        completion_tokens=20,
        total_tokens=120,
        prompt_tokens_details=SimpleNamespace(cached_tokens=60),
    )
    d = _usage_to_dict(usage)
    assert d["prompt_cache_hit_tokens"] == 60
    assert d["prompt_cache_miss_tokens"] == 40  # 100 - 60


def test_token_tracker_records_and_aggregates_cache_columns():
    token_tracker.record_token_usage(
        "test-cache-model",
        prompt_tokens=10,
        completion_tokens=5,
        prompt_cache_hit_tokens=7,
        prompt_cache_miss_tokens=3,
    )
    rows = token_tracker.list_token_usage(limit=50)
    mine = [r for r in rows if r["model_name"] == "test-cache-model"]
    assert mine, "缓存记录未写入"
    assert mine[0]["prompt_cache_hit_tokens"] == 7
    assert mine[0]["prompt_cache_miss_tokens"] == 3

    cum = token_tracker.cumulative_usage()
    assert "cache_hit_rate" in cum
    assert cum["prompt_cache_hit_tokens"] >= 7


def test_token_tracker_failure_is_fail_open(monkeypatch):
    def unavailable():
        raise UnicodeDecodeError(
            "utf-8", b"\xd6", 0, 1, "invalid continuation byte"
        )

    monkeypatch.setattr(token_tracker, "get_session", unavailable)

    assert token_tracker.record_token_usage("model", prompt_tokens=1) is False


def test_deepseek_records_auditable_prompt_fingerprints():
    model = "test-cache-fingerprint-model"
    client = _FakeClient(response=_resp(_msg("ok"), usage=_usage()))
    adapter = _adapter(client)
    adapter.model_name = model
    messages = [
        {"role": "system", "content": "stable rules"},
        {"role": "user", "content": "first task"},
    ]

    adapter.generate(messages)

    row = next(
        item
        for item in token_tracker.list_token_usage(limit=100)
        if item["model_name"] == model
    )
    expected_stable, expected_prompt = _request_fingerprints(messages)
    assert row["provider_name"] == "deepseek"
    assert row["request_kind"] == "chat"
    assert row["stable_prefix_fingerprint"] == expected_stable
    assert row["prompt_fingerprint"] == expected_prompt


def test_stable_prefix_fingerprint_survives_volatile_user_suffix():
    first = [
        {"role": "system", "content": "stable rules"},
        {"role": "user", "content": "first task"},
    ]
    second = [
        {"role": "system", "content": "stable rules"},
        {"role": "user", "content": "different task"},
    ]

    stable_a, prompt_a = _request_fingerprints(first, [{"type": "function"}])
    stable_b, prompt_b = _request_fingerprints(second, [{"type": "function"}])

    assert stable_a == stable_b
    assert prompt_a != prompt_b


def test_stable_prefix_fingerprint_excludes_marked_request_context():
    from arforge.prompt import VOLATILE_CONTEXT_MARKER

    first = [
        {
            "role": "system",
            "content": "stable rules"
            + VOLATILE_CONTEXT_MARKER
            + "## Relevant Memory\nfirst",
        },
        {"role": "user", "content": "task"},
    ]
    second = [
        {
            "role": "system",
            "content": "stable rules"
            + VOLATILE_CONTEXT_MARKER
            + "## Relevant Memory\nsecond",
        },
        {"role": "user", "content": "task"},
    ]

    stable_a, prompt_a = _request_fingerprints(first)
    stable_b, prompt_b = _request_fingerprints(second)

    assert stable_a == stable_b
    assert prompt_a != prompt_b


def test_system_prompt_extra_preserves_reasoning_and_reuses_stable_prefix():
    from arforge.prompt import build_system_prompt

    first_prompt = build_system_prompt(
        extra="## Relevant Memory\nfirst",
        with_reasoning=True,
        user_input="analyze the project",
    )
    second_prompt = build_system_prompt(
        extra="## Relevant Memory\nsecond",
        with_reasoning=True,
        user_input="a different task",
    )
    first_messages = [{"role": "system", "content": first_prompt}]
    second_messages = [{"role": "system", "content": second_prompt}]

    stable_a, prompt_a = _request_fingerprints(first_messages)
    stable_b, prompt_b = _request_fingerprints(second_messages)

    assert "<thinking>" in first_prompt
    assert "first" in first_prompt
    assert "second" in second_prompt
    assert stable_a == stable_b
    assert prompt_a != prompt_b


def test_cache_slo_requires_instrumented_long_term_evidence():
    model = "test-cache-slo-model"
    with token_tracker.token_usage_scope(run_id="run-1", task_id="task-1"):
        for suffix in ("a", "b"):
            stable, prompt = _request_fingerprints(
                [
                    {"role": "system", "content": "stable rules"},
                    {"role": "user", "content": suffix},
                ]
            )
            token_tracker.record_token_usage(
                model,
                prompt_tokens=100,
                prompt_cache_hit_tokens=99,
                prompt_cache_miss_tokens=1,
                provider_name="deepseek",
                request_kind="chat",
                stable_prefix_fingerprint=stable,
                prompt_fingerprint=prompt,
            )

    report = token_tracker.cache_slo_report(
        model_name=model,
        target_hit_rate=0.99,
        minimum_calls=2,
        minimum_observed_tokens=200,
        minimum_span_hours=0,
        minimum_prefix_reuse_rate=1,
    )

    assert report["status"] == "pass"
    assert report["cache_hit_rate"] == 0.99
    assert report["instrumented_calls"] == 2
    assert report["formal_runs"] == 1
    assert report["formal_tasks"] == 1

    report = token_tracker.cache_slo_report(
        model_name=model,
        minimum_calls=50,
        minimum_observed_tokens=1_000_000,
        minimum_span_hours=168,
    )
    assert report["status"] == "insufficient_evidence"
    assert "minimum_calls" in report["failed_checks"]


def test_cache_slo_operational_default_is_97_percent():
    model = "test-cache-slo-default-97-model"
    with token_tracker.token_usage_scope(run_id="run-default", task_id="task-default"):
        for suffix in ("a", "b"):
            stable, prompt = _request_fingerprints(
                [
                    {"role": "system", "content": "stable default rules"},
                    {"role": "user", "content": suffix},
                ]
            )
            token_tracker.record_token_usage(
                model,
                prompt_tokens=100,
                prompt_cache_hit_tokens=97,
                prompt_cache_miss_tokens=3,
                provider_name="deepseek",
                request_kind="chat",
                stable_prefix_fingerprint=stable,
                prompt_fingerprint=prompt,
            )

    report = token_tracker.cache_slo_report(
        model_name=model,
        minimum_calls=2,
        minimum_observed_tokens=200,
        minimum_span_hours=0,
        minimum_prefix_reuse_rate=1,
    )

    assert report["target_hit_rate"] == 0.97
    assert report["checks"]["target_hit_rate"] is True
    assert report["status"] == "pass"
