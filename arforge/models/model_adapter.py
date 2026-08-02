"""Model adapter contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class ToolCallResponse:
    content: str
    finish_reason: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: Optional[dict] = None
    provider_content: Optional[list[dict]] = None


class ModelAdapter:
    """所有模型后端的统一契约。

    **kwargs 透传 provider 专属参数（如 response_format / tool_choice），
    使新能力可在不破坏旧调用的前提下逐步加入。
    """

    def generate(self, messages: list, max_tokens: int = None, temperature: float = None, **kwargs) -> str:
        raise NotImplementedError

    def stream_generate(self, messages: list, max_tokens: int = None, temperature: float = None, **kwargs):
        raise NotImplementedError

    def generate_with_tools(
        self,
        messages: list,
        tools: Optional[list[dict]] = None,
        max_tokens: int = None,
        temperature: float = None,
        **kwargs,
    ) -> ToolCallResponse:
        # 默认降级实现：不支持工具调用的后端退化为普通生成
        content = self.generate(messages, max_tokens=max_tokens, temperature=temperature)
        return ToolCallResponse(content=content, finish_reason="stop")

    def stream_generate_with_tools(
        self,
        messages: list,
        tools: Optional[list[dict]] = None,
        max_tokens: int = None,
        temperature: float = None,
        tool_choice: str = "auto",
        on_content=None,
        on_reasoning=None,
        timeout: float | None = None,
        should_stop=None,
        **kwargs,
    ) -> ToolCallResponse:
        if should_stop is not None and should_stop():
            raise InterruptedError("operation cancelled or timed out")
        response = self.generate_with_tools(
            messages,
            tools=tools,
            max_tokens=max_tokens,
            temperature=temperature,
            tool_choice=tool_choice,
            **({"timeout": timeout} if timeout is not None else {}),
            **kwargs,
        )
        if on_content and response.content:
            on_content(response.content)
        return response


class ModelRateLimitError(RuntimeError):
    """Raised before a provider call when the shared cost budget is exhausted."""


class RateLimitedAdapter(ModelAdapter):
    """Central provider wrapper used by chat, planning and multi-agent paths."""

    def __init__(self, delegate, limiter=None):
        self.delegate = delegate
        if limiter is None:
            from arforge.security_guard import get_rate_limiter

            limiter = get_rate_limiter()
        self.limiter = limiter

    def _acquire(self) -> None:
        if not self.limiter.acquire():
            raise ModelRateLimitError("model rate limit reached; wait before retrying")

    def generate(self, messages: list, max_tokens: int = None, temperature: float = None, **kwargs) -> str:
        self._acquire()
        return self.delegate.generate(messages, max_tokens=max_tokens, temperature=temperature, **kwargs)

    def stream_generate(self, messages: list, max_tokens: int = None, temperature: float = None, **kwargs):
        self._acquire()
        yield from self.delegate.stream_generate(messages, max_tokens=max_tokens, temperature=temperature, **kwargs)

    def generate_with_tools(
        self,
        messages: list,
        tools: Optional[list[dict]] = None,
        max_tokens: int = None,
        temperature: float = None,
        **kwargs,
    ) -> ToolCallResponse:
        # 工具调用同样纳入限流（修正此前 __getattr__ 绕过限流的问题）
        self._acquire()
        return self.delegate.generate_with_tools(
            messages, tools=tools, max_tokens=max_tokens, temperature=temperature, **kwargs
        )

    def stream_generate_with_tools(
        self,
        messages: list,
        tools: Optional[list[dict]] = None,
        max_tokens: int = None,
        temperature: float = None,
        tool_choice: str = "auto",
        on_content=None,
        on_reasoning=None,
        timeout: float | None = None,
        should_stop=None,
        **kwargs,
    ) -> ToolCallResponse:
        self._acquire()
        stream_method = getattr(self.delegate, "stream_generate_with_tools", None)
        if callable(stream_method):
            return stream_method(
                messages,
                tools=tools,
                max_tokens=max_tokens,
                temperature=temperature,
                tool_choice=tool_choice,
                on_content=on_content,
                on_reasoning=on_reasoning,
                timeout=timeout,
                should_stop=should_stop,
                **kwargs,
            )
        if should_stop is not None and should_stop():
            raise InterruptedError("operation cancelled or timed out")
        response = self.delegate.generate_with_tools(
            messages,
            tools=tools,
            max_tokens=max_tokens,
            temperature=temperature,
            tool_choice=tool_choice,
            **({"timeout": timeout} if timeout is not None else {}),
            **kwargs,
        )
        if on_content and response.content:
            on_content(response.content)
        return response

    def __getattr__(self, name):
        return getattr(self.delegate, name)
