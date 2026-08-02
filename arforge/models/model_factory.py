"""Model adapter factory (T21 — multi-provider).

Supports:
  - deepseek : DeepSeek (OpenAI-compatible, default)
  - openai   : OpenAI (GPT-4o, GPT-4o-mini, o3-mini, etc.)
  - anthropic: reference terminal agent provider (Sonnet, Opus, Haiku)
  - openai-compatible : generic OpenAI-compatible (vLLM, Ollama, etc.)
"""

from __future__ import annotations

from arforge.models.deepseek_adapter import DeepSeekAdapter
from arforge.models.model_adapter import RateLimitedAdapter
from arforge.models.provider_adapters import AnthropicAdapter, OpenAIAdapter


def create_model_adapter(
    provider: str = "",
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
):
    """Create a model adapter for the given provider.

    If provider is empty, reads ARFORGE_PROVIDER from config (default: "deepseek").
    Explicit connection values are intended for the encrypted local model
    configuration runtime; callers never need to mutate process environment.
    """
    if not provider:
        import config
        provider = config.ARFORGE_PROVIDER

    normalized = provider.lower()

    if normalized in {"deepseek", "openai-compatible"}:
        return RateLimitedAdapter(DeepSeekAdapter(api_key=api_key, base_url=base_url, model=model))

    if normalized == "openai":
        return RateLimitedAdapter(OpenAIAdapter(api_key=api_key, base_url=base_url, model=model))

    if normalized == "anthropic":
        adapter = AnthropicAdapter(api_key=api_key, base_url=base_url, model=model)
        if adapter.client is None:
            raise RuntimeError(
                "Anthropic SDK is not installed. Run: pip install anthropic"
            )
        return RateLimitedAdapter(adapter)

    if normalized == "auto":
        return _auto_detect()

    raise ValueError(
        f"Unsupported model provider: {provider}. "
        f"Supported: deepseek, openai, anthropic, auto"
    )


def _auto_detect() -> RateLimitedAdapter:
    """Auto-detect the best available provider.

    Priority: anthropic > openai > deepseek
    Falls back to DeepSeek as default.
    """
    import config

    if config.ANTHROPIC_API_KEY:
        return RateLimitedAdapter(AnthropicAdapter())

    if config.OPENAI_API_KEY:
        return RateLimitedAdapter(OpenAIAdapter())

    if config.DEEPSEEK_API_KEY:
        return RateLimitedAdapter(DeepSeekAdapter())

    # Default fallback — will error at first API call if not configured
    return RateLimitedAdapter(DeepSeekAdapter())


def list_available_providers() -> dict[str, bool]:
    """Return provider availability after resolving environment and secure storage.

    Desktop credentials are encrypted outside process environment variables, so
    checking environment variables alone incorrectly reports a configured
    provider as unavailable.
    """
    from arforge.product.model_config_runtime import SUPPORTED_PROVIDERS, get_model_config

    runtime = get_model_config()
    return {
        provider_id: bool(runtime.get_resolved_config(provider_id).get("resolved"))
        for provider_id in SUPPORTED_PROVIDERS
    }
