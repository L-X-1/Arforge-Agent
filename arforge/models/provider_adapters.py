"""OpenAI-compatible model adapter (T21).

Generic adapter for any OpenAI-compatible API: OpenAI, DeepSeek, local
OpenAI-compatible servers (vLLM, Ollama, etc.). Also provides a dedicated
Anthropic API adapter for external model provider.

Uses the same resilience / token tracking / streaming infrastructure as
the existing DeepSeek adapter.
"""

from __future__ import annotations

import json

from arforge.models.deepseek_adapter import StreamChunk, _usage_to_dict
from arforge.models.model_adapter import ModelAdapter, ToolCall, ToolCallResponse
from arforge.models.resilience import RetryPolicy, call_with_retry
from arforge.models.token_tracker import record_token_usage
from arforge.product.model_config_runtime import validate_model_endpoint

try:
    from openai import OpenAI
except Exception:
    OpenAI = None


def _normalized_effort(value: object) -> str | None:
    if value in (None, ""):
        return None
    from arforge.reasoning.effort import normalize_reasoning_effort

    return normalize_reasoning_effort(str(value))


def _is_openai_reasoning_model(model: str) -> bool:
    name = str(model or "").strip().casefold()
    return name.startswith(("o1", "o3", "o4", "gpt-5"))


def _openai_generation_controls(model: str, effort: object, max_tokens: int) -> dict:
    if not _is_openai_reasoning_model(model):
        return {"max_tokens": max_tokens}
    tier = _normalized_effort(effort) or "medium"
    return {
        "max_completion_tokens": max_tokens,
        "reasoning_effort": "high" if tier == "ultra" else tier,
    }


def _anthropic_generation_controls(model: str, effort: object) -> dict:
    tier = _normalized_effort(effort)
    if tier is None:
        return {}
    name = str(model or "").strip().casefold()
    markers = (
        "fable-5", "mythos", "opus-4-5", "opus-4-6", "opus-4-7",
        "opus-4-8", "sonnet-4-6", "sonnet-5",
    )
    if not any(marker in name for marker in markers):
        return {}
    controls = {"output_config": {"effort": "max" if tier == "ultra" else tier}}
    if any(marker in name for marker in (
        "fable-5", "mythos", "opus-4-6", "opus-4-7", "opus-4-8",
        "sonnet-4-6", "sonnet-5",
    )):
        controls["thinking"] = {"type": "adaptive"}
    return controls


def _to_anthropic_messages(messages: list[dict]) -> tuple[str, list[dict]]:
    """Convert the agent loop's OpenAI-style tool transcript for Anthropic APIs."""
    system_parts: list[str] = []
    converted: list[dict] = []

    def append(role: str, content):
        if converted and converted[-1]["role"] == role:
            previous = converted[-1]["content"]
            previous_blocks = previous if isinstance(previous, list) else [{"type": "text", "text": str(previous)}]
            next_blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content)}]
            converted[-1] = {"role": role, "content": [*previous_blocks, *next_blocks]}
        else:
            converted.append({"role": role, "content": content})

    for message in messages:
        role = str(message.get("role", ""))
        content = message.get("content", "")
        if role == "system":
            if content:
                system_parts.append(str(content))
            continue
        if role == "tool":
            append("user", [{
                "type": "tool_result",
                "tool_use_id": str(message.get("tool_call_id", "")),
                "content": str(content or ""),
            }])
            continue
        if role == "assistant" and message.get("tool_calls"):
            preserved = message.get("provider_content")
            if isinstance(preserved, list) and preserved:
                append("assistant", preserved)
                continue
            blocks: list[dict] = []
            if content:
                blocks.append({"type": "text", "text": str(content)})
            for tool_call in message.get("tool_calls") or []:
                function = tool_call.get("function") or {}
                raw_arguments = function.get("arguments") or "{}"
                try:
                    arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
                except (json.JSONDecodeError, TypeError):
                    arguments = {"raw": str(raw_arguments)}
                if not isinstance(arguments, dict):
                    arguments = {"value": arguments}
                blocks.append({
                    "type": "tool_use",
                    "id": str(tool_call.get("id", "")),
                    "name": str(function.get("name", "")),
                    "input": arguments,
                })
            append("assistant", blocks)
            continue
        if role in {"user", "assistant"}:
            append(role, content)

    return "\n\n".join(system_parts), converted


class OpenAIAdapter(ModelAdapter):
    """Generic OpenAI-compatible adapter — works with OpenAI, DeepSeek,
    vLLM, Ollama, and any other OpenAI-compatible API."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ):
        import config

        self.api_key = api_key or config.OPENAI_API_KEY
        self.base_url = validate_model_endpoint(
            base_url or config.OPENAI_BASE_URL,
            allow_empty=False,
        )
        self.model_name = model or config.OPENAI_MODEL
        self.client = None
        self._last_reasoning_content = ""
        self.reasoning_effort: str | None = None
        self._retry = RetryPolicy(
            max_retries=int(getattr(config, "MODEL_MAX_RETRIES", 3))
        )
        self._timeout = float(getattr(config, "MODEL_TIMEOUT", 0))

        if OpenAI is not None and self.api_key:
            self.client = OpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                timeout=self._timeout or None,
            )

    def _require_client(self):
        if self.client is None:
            raise RuntimeError(
                "OpenAI API key or openai dependency is not configured"
            )
        return self.client

    def generate(self, messages, **kwargs):
        client = self._require_client()
        model = kwargs.pop("model", self.model_name)
        max_tokens = kwargs.pop("max_tokens", None) or int(
            getattr(__import__("config"), "CHAT_MAX_TOKENS", 4096)
        )
        temperature = kwargs.pop("temperature", None)
        if temperature is None:
            temperature = float(getattr(__import__("config"), "CHAT_TEMPERATURE", 0.7))

        def _call():
            request = {
                "model": model,
                "messages": messages,
                **_openai_generation_controls(model, self.reasoning_effort, max_tokens),
                **kwargs,
            }
            if not _is_openai_reasoning_model(model):
                request["temperature"] = temperature
            return client.chat.completions.create(**request)

        response = call_with_retry(_call, self._retry)
        record_token_usage(
            model_name=model,
            prompt_tokens=response.usage.prompt_tokens,
            completion_tokens=response.usage.completion_tokens,
            total_tokens=response.usage.total_tokens,
        )
        return response.choices[0].message.content or ""

    def generate_with_tools(self, messages, tools, **kwargs):
        client = self._require_client()
        model = kwargs.pop("model", self.model_name)
        max_tokens = kwargs.pop("max_tokens", None) or int(
            getattr(__import__("config"), "CHAT_MAX_TOKENS", 4096)
        )

        def _call():
            return client.chat.completions.create(
                model=model,
                messages=messages,
                tools=tools,
                **_openai_generation_controls(model, self.reasoning_effort, max_tokens),
                **kwargs,
            )

        response = call_with_retry(_call, self._retry)
        usage = _usage_to_dict(response.usage)
        if usage:
            record_token_usage(
                model_name=model,
                prompt_tokens=usage["prompt_tokens"],
                completion_tokens=usage["completion_tokens"],
                total_tokens=usage["total_tokens"],
            )

        choice = response.choices[0]
        message = choice.message

        tool_calls = []
        if message.tool_calls:
            for tc in message.tool_calls:
                tool_calls.append(
                    ToolCall(
                        id=tc.id,
                        name=tc.function.name,
                        arguments=tc.function.arguments,
                    )
                )

        return ToolCallResponse(
            content=message.content or "",
            tool_calls=tool_calls,
            finish_reason=choice.finish_reason or "stop",
            usage=usage or None,
        )

    def stream_generate(self, messages, **kwargs):
        client = self._require_client()
        model = kwargs.pop("model", self.model_name)
        max_tokens = kwargs.pop("max_tokens", None) or int(
            getattr(__import__("config"), "CHAT_MAX_TOKENS", 4096)
        )
        temperature = kwargs.pop("temperature", None)
        if temperature is None:
            temperature = float(getattr(__import__("config"), "CHAT_TEMPERATURE", 0.7))

        def _stream():
            request = {
                "model": model,
                "messages": messages,
                "stream": True,
                "stream_options": {"include_usage": True},
                **_openai_generation_controls(model, self.reasoning_effort, max_tokens),
                **kwargs,
            }
            if not _is_openai_reasoning_model(model):
                request["temperature"] = temperature
            return client.chat.completions.create(**request)

        stream = call_with_retry(_stream, self._retry)
        total_tokens = 0
        for chunk in stream:
            if chunk.usage:
                total_tokens = chunk.usage.total_tokens
                record_token_usage(
                    model_name=model,
                    prompt_tokens=chunk.usage.prompt_tokens,
                    completion_tokens=chunk.usage.completion_tokens,
                    total_tokens=total_tokens,
                )
            if chunk.choices and chunk.choices[0].delta.content:
                yield StreamChunk(text=chunk.choices[0].delta.content)


class AnthropicAdapter(ModelAdapter):
    """Anthropic API model adapter.

    Uses the external provider SDK. Gracefully falls back with a clear
    error message if the SDK is not installed.
    """

    # Extended-thinking providers require signed thinking blocks to be passed
    # back beside tool_use blocks. Local tool planning cannot manufacture those
    # signatures, so the shared loop must obtain tool calls from the provider.
    requires_signed_tool_transcript = True

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ):
        import config

        self.api_key = api_key or config.ANTHROPIC_API_KEY
        self.base_url = validate_model_endpoint(
            base_url or config.ANTHROPIC_BASE_URL,
            allow_empty=False,
        )
        self.model_name = model or config.ANTHROPIC_MODEL
        self.client = None
        self._last_reasoning_content = ""
        self.reasoning_effort: str | None = None
        self._timeout = float(getattr(config, "MODEL_TIMEOUT", 0))
        self._retry = RetryPolicy(
            max_retries=int(getattr(config, "MODEL_MAX_RETRIES", 3))
        )

        if self.api_key:
            try:
                import anthropic

                kwargs = {"api_key": self.api_key, "timeout": self._timeout or None}
                if self.base_url:
                    kwargs["base_url"] = self.base_url
                self.client = anthropic.Anthropic(**kwargs)
            except ImportError:
                pass

    def _require_client(self):
        if self.client is None:
            if self.api_key is None:
                raise RuntimeError(
                    "Anthropic API key is not configured. "
                    "Set ANTHROPIC_API_KEY environment variable."
                )
            raise RuntimeError(
                "Anthropic SDK is not installed. Run: pip install anthropic"
            )
        return self.client

    def generate(self, messages, **kwargs):
        client = self._require_client()
        model = kwargs.pop("model", self.model_name)
        timeout = kwargs.pop("timeout", None)
        max_tokens = kwargs.pop("max_tokens", None) or int(
            getattr(__import__("config"), "CHAT_MAX_TOKENS", 4096)
        )
        temperature = kwargs.pop("temperature", None)
        if temperature is None:
            temperature = float(getattr(__import__("config"), "CHAT_TEMPERATURE", 0.7))

        system, user_messages = _to_anthropic_messages(messages)

        def _call():
            kwargs_args = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": user_messages,
            }
            controls = _anthropic_generation_controls(model, self.reasoning_effort)
            if system:
                kwargs_args["system"] = system
            if temperature > 0 and "thinking" not in controls:
                kwargs_args["temperature"] = temperature
            if timeout is not None:
                requested = max(1.0, float(timeout))
                kwargs_args["timeout"] = min(requested, self._timeout) if self._timeout > 0 else requested
            kwargs_args.update(controls)
            return client.messages.create(**kwargs_args)

        response = call_with_retry(_call, self._retry)

        # Extract text from response
        text_parts = []
        for block in response.content:
            if hasattr(block, "text"):
                text_parts.append(block.text)

        result = "\n".join(text_parts)

        # Record token usage
        record_token_usage(
            model_name=model,
            prompt_tokens=response.usage.input_tokens,
            completion_tokens=response.usage.output_tokens,
            total_tokens=response.usage.input_tokens + response.usage.output_tokens,
        )
        return result

    def generate_with_tools(self, messages, tools, **kwargs):
        client = self._require_client()
        model = kwargs.pop("model", self.model_name)
        timeout = kwargs.pop("timeout", None)
        max_tokens = kwargs.pop("max_tokens", None) or int(
            getattr(__import__("config"), "CHAT_MAX_TOKENS", 4096)
        )

        system, user_messages = _to_anthropic_messages(messages)

        # Convert OpenAI tool format to Anthropic tool format
        anthropic_tools = []
        # The agent loop intentionally passes ``tools=None`` when it forces a
        # final natural-language answer after exhausting its steps. Treat that
        # as an empty tool set instead of crashing the user-facing fallback.
        for tool in tools or []:
            if tool.get("type") == "function":
                func = tool["function"]
                anthropic_tools.append({
                    "name": func["name"],
                    "description": func.get("description", ""),
                    "input_schema": func.get("parameters", {"type": "object", "properties": {}}),
                })

        def _call():
            kwargs_args = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": user_messages,
            }
            if system:
                kwargs_args["system"] = system
            if anthropic_tools:
                kwargs_args["tools"] = anthropic_tools
            if timeout is not None:
                requested = max(1.0, float(timeout))
                kwargs_args["timeout"] = min(requested, self._timeout) if self._timeout > 0 else requested
            kwargs_args.update(_anthropic_generation_controls(model, self.reasoning_effort))
            return client.messages.create(**kwargs_args)

        response = call_with_retry(_call, self._retry)

        # Parse tool calls from response
        tool_calls = []
        content_text = ""
        provider_content: list[dict] = []
        for block in response.content:
            block_type = block.get("type", "") if isinstance(block, dict) else getattr(block, "type", "")
            if hasattr(block, "model_dump"):
                provider_content.append(block.model_dump(exclude_none=True))
            elif isinstance(block, dict):
                provider_content.append(dict(block))
            else:
                raw = {"type": block_type}
                for key in ("thinking", "signature", "data", "text", "id", "name", "input"):
                    value = getattr(block, key, None)
                    if value is not None:
                        raw[key] = value
                provider_content.append(raw)
            if block_type == "text":
                content_text = block.get("text", "") if isinstance(block, dict) else block.text
            elif block_type == "tool_use":
                tool_calls.append(
                    ToolCall(
                        id=block.get("id", "") if isinstance(block, dict) else block.id,
                        name=block.get("name", "") if isinstance(block, dict) else block.name,
                        arguments=__import__("json").dumps(block.get("input", {}) if isinstance(block, dict) else block.input),
                    )
                )

        record_token_usage(
            model_name=model,
            prompt_tokens=response.usage.input_tokens,
            completion_tokens=response.usage.output_tokens,
            total_tokens=response.usage.input_tokens + response.usage.output_tokens,
        )
        usage = {
            "prompt_tokens": int(response.usage.input_tokens or 0),
            "completion_tokens": int(response.usage.output_tokens or 0),
            "total_tokens": int(
                (response.usage.input_tokens or 0) + (response.usage.output_tokens or 0)
            ),
        }

        return ToolCallResponse(
            content=content_text,
            tool_calls=tool_calls,
            finish_reason=response.stop_reason or "stop",
            usage=usage,
            provider_content=provider_content,
        )

    def stream_generate(self, messages, **kwargs):
        client = self._require_client()
        model = kwargs.pop("model", self.model_name)
        timeout = kwargs.pop("timeout", None)
        max_tokens = kwargs.pop("max_tokens", None) or int(
            getattr(__import__("config"), "CHAT_MAX_TOKENS", 4096)
        )

        system, user_messages = _to_anthropic_messages(messages)

        def _stream():
            kwargs_args = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": user_messages,
            }
            if system:
                kwargs_args["system"] = system
            if timeout is not None:
                requested = max(1.0, float(timeout))
                kwargs_args["timeout"] = min(requested, self._timeout) if self._timeout > 0 else requested
            kwargs_args.update(_anthropic_generation_controls(model, self.reasoning_effort))
            return client.messages.stream(**kwargs_args)

        # Build and open the stream through the same retry boundary as other
        # provider operations.  The previous call created a second stream with
        # empty arguments, which dropped the selected model and messages.
        with call_with_retry(_stream, self._retry, label=f"anthropic.{model}") as stream:
            for text in stream.text_stream:
                yield StreamChunk(text=text)

        # Record usage from final message
        final = stream.get_final_message()
        if final and final.usage:
            record_token_usage(
                model_name=model,
                prompt_tokens=final.usage.input_tokens,
                completion_tokens=final.usage.output_tokens,
                total_tokens=final.usage.input_tokens + final.usage.output_tokens,
            )
# ── Provider detection ────────────────────────────────────────────────


def get_available_providers() -> dict[str, bool]:
    """Check which providers are available based on configured API keys."""
    import config
    return {
        "deepseek": bool(config.DEEPSEEK_API_KEY),
        "openai": bool(config.OPENAI_API_KEY),
        "anthropic": bool(config.ANTHROPIC_API_KEY),
    }
