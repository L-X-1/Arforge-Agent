"""DeepSeek OpenAI-compatible model adapter.

P0-1：在原生 function calling 基础上补齐企业级能力：
- response_format：结构化(JSON)输出
- stream_options：流式也能拿到真实 token usage
- DeepSeek 上下文缓存命中 token（prompt_cache_hit_tokens）读取与记录
- 指数退避重试 + 超时（经 resilience 层），重试耗尽抛 ModelCallError 供上层降级
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import ipaddress
import json
from urllib.parse import urlparse

import config
from arforge.models.model_adapter import ModelAdapter, ToolCall, ToolCallResponse
from arforge.models.resilience import RetryPolicy, call_with_retry
from arforge.models.token_tracker import record_token_usage
from arforge.product.model_config_runtime import validate_model_endpoint

try:
    import httpx
    from openai import OpenAI
except Exception:  # pragma: no cover - exercised only when dependency is absent
    httpx = None
    OpenAI = None


@dataclass
class StreamChunk:
    text: str
    kind: str = "content"  # "content" | "reasoning" | "usage"
    reasoning_content: str = ""
    usage: dict | None = None


def _usage_to_dict(usage) -> dict | None:
    """把 provider 的 usage 对象转为 dict，并解析 DeepSeek 缓存命中字段。

    兼容两种返回形态：顶层 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
    或 OpenAI 风格的 prompt_tokens_details.cached_tokens。
    """
    if usage is None:
        return None
    prompt = getattr(usage, "prompt_tokens", 0) or 0
    completion = getattr(usage, "completion_tokens", 0) or 0
    total = getattr(usage, "total_tokens", 0) or 0

    hit = getattr(usage, "prompt_cache_hit_tokens", None)
    miss = getattr(usage, "prompt_cache_miss_tokens", None)
    if hit is None:
        details = getattr(usage, "prompt_tokens_details", None)
        if details is not None:
            hit = getattr(details, "cached_tokens", None)
    hit = hit or 0
    if miss is None:
        miss = max(0, prompt - hit)

    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "prompt_cache_hit_tokens": hit,
        "prompt_cache_miss_tokens": miss,
    }


def _fingerprint(payload) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _request_fingerprints(messages: list, tools: list | None = None) -> tuple[str, str]:
    """Identify the reusable base prefix and the exact request prompt.

    DeepSeek performs prefix matching provider-side. These hashes do not claim
    that a cache hit occurred; they prove which stable prefix and exact prompt
    produced the provider-reported hit/miss token counts.
    """
    from arforge.prompt import VOLATILE_CONTEXT_MARKER

    system_prefix = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "system":
            continue
        normalized = dict(message)
        content = normalized.get("content")
        if isinstance(content, str):
            normalized["content"] = content.split(VOLATILE_CONTEXT_MARKER, 1)[0]
        system_prefix.append(normalized)
    stable_payload = {"system": system_prefix, "tools": tools or []}
    prompt_payload = {"messages": messages, "tools": tools or []}
    return _fingerprint(stable_payload), _fingerprint(prompt_payload)


class DeepSeekAdapter(ModelAdapter):
    _OFFICIAL_V4_MODELS = {"deepseek-v4-flash", "deepseek-v4-pro"}

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ):
        self.api_key = api_key or config.DEEPSEEK_API_KEY
        self.base_url = validate_model_endpoint(
            base_url or config.DEEPSEEK_BASE_URL,
            allow_empty=False,
        )
        self.model_name = model or config.DEEPSEEK_MODEL
        # DeepSeek thinking mode rejects named/required function choices with
        # HTTP 400. Keep the full tool schema and reasoning mode, but let the
        # model select from the narrowed tool set with the supported "auto"
        # mode instead of disabling thinking.
        self.supports_forced_tool_choice = False
        self.client = None
        self._last_reasoning_content = ""
        self._retry = RetryPolicy(max_retries=int(getattr(config, "MODEL_MAX_RETRIES", 3)))
        self._timeout = float(getattr(config, "MODEL_TIMEOUT", 0))
        if OpenAI is not None and self.api_key:
            client_options = {
                "api_key": self.api_key,
                "base_url": self.base_url,
                "timeout": self._timeout or None,
                # Arforge owns retry classification, backoff and evidence in
                # ``call_with_retry``. Disable the SDK's hidden retry layer so
                # attempts and fault-injection observations remain exact.
                "max_retries": 0,
            }
            endpoint_host = (urlparse(self.base_url).hostname or "").casefold()
            try:
                endpoint_address = ipaddress.ip_address(endpoint_host)
            except ValueError:
                endpoint_address = None
            if httpx is not None and (
                endpoint_host == "localhost"
                or (endpoint_address is not None and endpoint_address.is_loopback)
            ):
                # A loopback endpoint must never escape through host-level
                # HTTP(S)_PROXY settings.
                client_options["http_client"] = httpx.Client(trust_env=False)
            self.client = OpenAI(**client_options)

    def _require_client(self):
        if self.client is None:
            raise RuntimeError("DeepSeek API key or openai dependency is not configured")
        return self.client

    def _create(self, *, _retry_enabled: bool = True, **kwargs):
        """统一 provider 调用入口：超时 + 指数退避重试（仅对可恢复错误重试）。"""
        client = self._require_client()
        if self.model_name.casefold() in self._OFFICIAL_V4_MODELS:
            extra_body = dict(kwargs.get("extra_body") or {})
            extra_body.setdefault("thinking", {"type": "enabled"})
            kwargs["extra_body"] = extra_body
            kwargs.setdefault("reasoning_effort", "high")
            # Official V4 thinking mode rejects the tool_choice field entirely.
            kwargs.pop("tool_choice", None)
        if self._timeout > 0:
            kwargs.setdefault("timeout", self._timeout)
        if not _retry_enabled:
            return client.chat.completions.create(**kwargs)
        return call_with_retry(
            lambda: client.chat.completions.create(**kwargs),
            policy=self._retry,
            label=f"deepseek.{self.model_name}",
        )

    def _record_usage(
        self,
        usage_dict: dict | None,
        *,
        messages: list,
        tools: list | None = None,
        request_kind: str,
    ) -> None:
        if usage_dict:
            stable_prefix, prompt = _request_fingerprints(messages, tools)
            record_token_usage(
                self.model_name,
                prompt_tokens=usage_dict.get("prompt_tokens", 0),
                completion_tokens=usage_dict.get("completion_tokens", 0),
                total_tokens=usage_dict.get("total_tokens", 0),
                prompt_cache_hit_tokens=usage_dict.get("prompt_cache_hit_tokens", 0),
                prompt_cache_miss_tokens=usage_dict.get("prompt_cache_miss_tokens", 0),
                provider_name="deepseek",
                request_kind=request_kind,
                stable_prefix_fingerprint=stable_prefix,
                prompt_fingerprint=prompt,
            )

    def generate(self, messages: list, max_tokens: int = None, temperature: float = None, response_format=None) -> str:
        kwargs = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": max_tokens or config.CHAT_MAX_TOKENS,
            "temperature": config.CHAT_TEMPERATURE if temperature is None else temperature,
        }
        if response_format is not None:
            kwargs["response_format"] = response_format
        response = self._create(**kwargs)
        self._record_usage(
            _usage_to_dict(getattr(response, "usage", None)),
            messages=messages,
            request_kind="chat",
        )
        message = response.choices[0].message
        content = message.content or ""

        # Capture native reasoning_content from deepseek-reasoner models
        reasoning = getattr(message, "reasoning_content", None)
        if reasoning:
            self._last_reasoning_content = reasoning

        return content

    def stream_generate(
        self,
        messages: list,
        max_tokens: int = None,
        temperature: float = None,
        timeout: float | None = None,
        should_stop=None,
    ):
        kwargs = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": max_tokens or config.CHAT_MAX_TOKENS,
            "temperature": config.CHAT_TEMPERATURE if temperature is None else temperature,
            "stream": True,
            # 关键：要求流末返回 usage，否则流式拿不到 token 统计
            "stream_options": {"include_usage": True},
        }
        if timeout is not None:
            requested = max(1.0, float(timeout))
            kwargs["timeout"] = min(requested, self._timeout) if self._timeout > 0 else requested
        # A streaming response cannot be replayed safely after partial output.
        # Keep retry at the operation layer and fail this request promptly.
        stream = self._create(_retry_enabled=False, **kwargs)
        reasoning_buf = ""
        final_usage = None
        for chunk in stream:
            if should_stop is not None and should_stop():
                raise InterruptedError("operation cancelled or timed out")
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                final_usage = _usage_to_dict(usage)
            # usage-only chunk（DeepSeek 在流末返回，choices 可能为空）
            if not getattr(chunk, "choices", None):
                continue
            delta = chunk.choices[0].delta
            text = getattr(delta, "content", "") or ""

            reasoning = getattr(delta, "reasoning_content", "") or ""
            if reasoning:
                reasoning_buf += reasoning
                yield StreamChunk(reasoning, kind="reasoning", reasoning_content=reasoning)

            if text:
                yield StreamChunk(text, kind="content")

        self._last_reasoning_content = reasoning_buf
        if final_usage is not None:
            self._record_usage(
                final_usage,
                messages=messages,
                request_kind="chat_stream",
            )
            # 在流末向消费者透出真实 usage，便于上层做成本/缓存监控
            yield StreamChunk("", kind="usage", usage=final_usage)

    def generate_with_tools(
        self,
        messages: list,
        tools: list = None,
        max_tokens: int = None,
        temperature: float = None,
        tool_choice: str | dict = "auto",
        response_format=None,
    ) -> ToolCallResponse:
        kwargs = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": max_tokens or config.CHAT_MAX_TOKENS,
            "temperature": config.CHAT_TEMPERATURE if temperature is None else temperature,
        }
        if tools:
            kwargs["tools"] = tools
        if response_format is not None:
            kwargs["response_format"] = response_format
        response = self._create(**kwargs)
        choice = response.choices[0]
        message = choice.message
        tool_calls = []
        for call in getattr(message, "tool_calls", None) or []:
            tool_calls.append(ToolCall(call.id, call.function.name, call.function.arguments))
        usage_dict = _usage_to_dict(getattr(response, "usage", None))
        self._record_usage(
            usage_dict,
            messages=messages,
            tools=tools,
            request_kind="tools",
        )
        return ToolCallResponse(message.content or "", choice.finish_reason or "stop", tool_calls, usage_dict)

    def stream_generate_with_tools(
        self,
        messages: list,
        tools: list = None,
        max_tokens: int = None,
        temperature: float = None,
        tool_choice: str | dict = "auto",
        response_format=None,
        on_content=None,
        on_reasoning=None,
        timeout: float | None = None,
        should_stop=None,
        **extra,
    ) -> ToolCallResponse:
        """流式版 generate_with_tools：内容 token 经 on_content 实时回调（token 级输出）；

        同时累计 tool_calls / reasoning / usage，最终返回与 generate_with_tools 一致的
        ToolCallResponse，使 run_tool_loop 的工具检测逻辑无需改动。
        """
        kwargs = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": max_tokens or config.CHAT_MAX_TOKENS,
            "temperature": config.CHAT_TEMPERATURE if temperature is None else temperature,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            kwargs["tools"] = tools
        if response_format is not None:
            kwargs["response_format"] = response_format
        if timeout is not None:
            requested = max(1.0, float(timeout))
            kwargs["timeout"] = min(requested, self._timeout) if self._timeout > 0 else requested
        kwargs.update(extra)
        stream = self._create(_retry_enabled=False, **kwargs)

        content_parts: list[str] = []
        reasoning_buf = ""
        finish_reason = "stop"
        final_usage = None
        tool_acc: dict[int, dict] = {}

        for chunk in stream:
            if should_stop is not None and should_stop():
                raise InterruptedError("operation cancelled or timed out")
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                final_usage = _usage_to_dict(usage)
            if not getattr(chunk, "choices", None):
                continue
            choice = chunk.choices[0]
            if getattr(choice, "finish_reason", None):
                finish_reason = choice.finish_reason
            delta = choice.delta

            text = getattr(delta, "content", "") or ""
            if text:
                content_parts.append(text)
                if on_content:
                    on_content(text)

            reasoning = getattr(delta, "reasoning_content", "") or ""
            if reasoning:
                reasoning_buf += reasoning
                if on_reasoning:
                    on_reasoning(reasoning)

            for tcd in getattr(delta, "tool_calls", None) or []:
                idx = getattr(tcd, "index", 0) or 0
                slot = tool_acc.setdefault(idx, {"id": "", "name": "", "args": ""})
                if getattr(tcd, "id", None):
                    slot["id"] = tcd.id
                fn = getattr(tcd, "function", None)
                if fn is not None:
                    if getattr(fn, "name", None):
                        slot["name"] = fn.name
                    if getattr(fn, "arguments", None):
                        slot["args"] += fn.arguments

        self._last_reasoning_content = reasoning_buf
        if final_usage is not None:
            self._record_usage(
                final_usage,
                messages=messages,
                tools=tools,
                request_kind="tools_stream",
            )

        tool_calls = [
            ToolCall(slot["id"], slot["name"], slot["args"])
            for _idx, slot in sorted(tool_acc.items())
            if slot["name"]
        ]
        return ToolCallResponse("".join(content_parts), finish_reason, tool_calls, final_usage)

    @property
    def last_reasoning_content(self) -> str:
        return self._last_reasoning_content
