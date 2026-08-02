"""Tests for multi-provider support (T21)."""

from types import SimpleNamespace

import pytest


class TestModelFactory:
    """Provider selection and factory routing."""

    def test_create_deepseek_adapter(self):
        from arforge.models.model_factory import create_model_adapter

        adapter = create_model_adapter("deepseek")
        # RateLimitedAdapter wraps DeepSeekAdapter
        assert adapter is not None

    def test_create_openai_adapter(self):
        from arforge.models.model_factory import create_model_adapter

        adapter = create_model_adapter("openai")
        assert adapter is not None

    def test_create_anthropic_adapter(self):
        from arforge.models.model_factory import create_model_adapter

        # Anthropic adapter should create without SDK installed
        try:
            adapter = create_model_adapter("anthropic")
            assert adapter is not None
        except RuntimeError as e:
            # SDK not installed — acceptable
            assert "anthropic" in str(e).lower() or "Anthropic" in str(e)

    def test_create_auto_detect(self):
        from arforge.models.model_factory import create_model_adapter

        adapter = create_model_adapter("auto")
        assert adapter is not None

    def test_unsupported_provider_raises(self):
        from arforge.models.model_factory import create_model_adapter

        with pytest.raises(ValueError, match="Unsupported"):
            create_model_adapter("nonexistent_provider_xyz")

    def test_deepseek_is_openai_compatible_alias(self):
        from arforge.models.model_factory import create_model_adapter

        ds = create_model_adapter("deepseek")
        oc = create_model_adapter("openai-compatible")
        assert type(ds) is type(oc)

    def test_empty_provider_uses_config_default(self, monkeypatch):
        monkeypatch.setenv("ARFORGE_PROVIDER", "deepseek")
        from arforge.models.model_factory import create_model_adapter

        adapter = create_model_adapter("")  # reads from config
        assert adapter is not None


class TestProviderAvailability:
    """Provider detection from environment."""

    def test_list_available_providers(self):
        from arforge.models.model_factory import list_available_providers

        available = list_available_providers()
        assert isinstance(available, dict)
        assert "deepseek" in available
        assert "openai" in available
        assert "anthropic" in available
        # At least deepseek should be available
        assert available["deepseek"] is True


class TestOpenAIAdapter:
    """OpenAI adapter functionality."""

    def test_adapter_initialization(self):
        from arforge.models.provider_adapters import OpenAIAdapter

        adapter = OpenAIAdapter(
            api_key="sk-test",
            base_url="https://api.openai.com/v1",
            model="gpt-4o",
        )
        assert adapter.model_name == "gpt-4o"
        assert adapter.base_url == "https://api.openai.com/v1"

    def test_adapter_no_key_no_client(self):
        from arforge.models.provider_adapters import OpenAIAdapter

        adapter = OpenAIAdapter(api_key=None)
        assert adapter.client is None

    def test_reasoning_model_uses_native_effort_and_completion_budget(self):
        from arforge.models.provider_adapters import _openai_generation_controls

        assert _openai_generation_controls("gpt-5.1", "low", 4096) == {
            "max_completion_tokens": 4096,
            "reasoning_effort": "low",
        }
        assert _openai_generation_controls("gpt-5.1", "ultra", 8192) == {
            "max_completion_tokens": 8192,
            "reasoning_effort": "high",
        }
        assert _openai_generation_controls("gpt-4o", "ultra", 8192) == {
            "max_tokens": 8192,
        }

    def test_tool_response_exposes_provider_usage_to_agent_tracing(self, monkeypatch):
        from arforge.models.provider_adapters import OpenAIAdapter

        usage = SimpleNamespace(prompt_tokens=7, completion_tokens=3, total_tokens=10)
        response = SimpleNamespace(
            usage=usage,
            choices=[SimpleNamespace(
                finish_reason="stop",
                message=SimpleNamespace(content="done", tool_calls=[]),
            )],
        )

        class Completions:
            def create(self, **_kwargs):
                return response

        monkeypatch.setattr(
            "arforge.models.provider_adapters.record_token_usage",
            lambda **_kwargs: None,
        )
        adapter = OpenAIAdapter(api_key="test-key", model="gpt-4o")
        adapter.client = SimpleNamespace(
            chat=SimpleNamespace(completions=Completions())
        )

        result = adapter.generate_with_tools(
            [{"role": "user", "content": "work"}],
            tools=[],
        )

        assert result.usage["prompt_tokens"] == 7
        assert result.usage["completion_tokens"] == 3
        assert result.usage["total_tokens"] == 10


class TestAnthropicAdapter:
    """Anthropic adapter functionality."""

    def test_adapter_initialization(self):
        from arforge.models.provider_adapters import AnthropicAdapter

        adapter = AnthropicAdapter(
            api_key="sk-ant-test",
            model="vendor-compatible-v1",
        )
        assert adapter.model_name == "vendor-compatible-v1"

    def test_adapter_no_key_no_client(self, monkeypatch):
        from arforge.models.provider_adapters import AnthropicAdapter

        monkeypatch.setattr("config.ANTHROPIC_API_KEY", "")

        adapter = AnthropicAdapter(api_key=None)
        assert adapter.client is None

    def test_current_reasoning_model_uses_adaptive_thinking_and_effort(self):
        from arforge.models.provider_adapters import _anthropic_generation_controls

        assert _anthropic_generation_controls("claude-sonnet-4-6", "medium") == {
            "output_config": {"effort": "medium"},
            "thinking": {"type": "adaptive"},
        }
        assert _anthropic_generation_controls("claude-opus-4-8", "ultra") == {
            "output_config": {"effort": "max"},
            "thinking": {"type": "adaptive"},
        }
        assert _anthropic_generation_controls("external-compatible-model", "high") == {}

    def test_stream_generation_passes_model_and_messages_to_provider(self, monkeypatch):
        from arforge.models.provider_adapters import AnthropicAdapter

        calls = []
        usage_records = []

        class FakeStream:
            text_stream = iter(("first", " second"))

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def get_final_message(self):
                return SimpleNamespace(
                    usage=SimpleNamespace(input_tokens=3, output_tokens=2)
                )

        class FakeMessages:
            def stream(self, **kwargs):
                calls.append(kwargs)
                return FakeStream()

        monkeypatch.setattr(
            "arforge.models.provider_adapters.record_token_usage",
            lambda **kwargs: usage_records.append(kwargs),
        )
        adapter = AnthropicAdapter(api_key="test-key", model="external-compatible-model")
        adapter.client = SimpleNamespace(messages=FakeMessages())

        chunks = list(adapter.stream_generate([
            {"role": "system", "content": "follow policy"},
            {"role": "user", "content": "implement the change"},
        ], max_tokens=32))

        assert "".join(chunk.text for chunk in chunks) == "first second"
        assert calls == [{
            "model": "external-compatible-model",
            "max_tokens": 32,
            "messages": [{"role": "user", "content": "implement the change"}],
            "system": "follow policy",
        }]
        assert usage_records == [{
            "model_name": "external-compatible-model",
            "prompt_tokens": 3,
            "completion_tokens": 2,
            "total_tokens": 5,
        }]

    def test_converts_agent_tool_transcript_to_native_provider_blocks(self):
        from arforge.models.provider_adapters import _to_anthropic_messages

        system, messages = _to_anthropic_messages([
            {"role": "system", "content": "follow policy"},
            {"role": "user", "content": "calculate 6*7"},
            {
                "role": "assistant",
                "content": "I will calculate it.",
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "calculate", "arguments": '{"expression":"6*7"}'},
                }],
            },
            {"role": "tool", "tool_call_id": "call-1", "content": "42"},
            {"role": "user", "content": "Return the final result."},
        ])

        assert system == "follow policy"
        assert messages == [
            {"role": "user", "content": "calculate 6*7"},
            {"role": "assistant", "content": [
                {"type": "text", "text": "I will calculate it."},
                {"type": "tool_use", "id": "call-1", "name": "calculate", "input": {"expression": "6*7"}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call-1", "content": "42"},
                {"type": "text", "text": "Return the final result."},
            ]},
        ]

    def test_generate_with_tools_accepts_none_for_forced_final_answer(self, monkeypatch):
        from arforge.models.provider_adapters import AnthropicAdapter

        calls = []

        class FakeMessages:
            def create(self, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(
                    content=[SimpleNamespace(type="text", text="final answer")],
                    usage=SimpleNamespace(input_tokens=4, output_tokens=2),
                    stop_reason="end_turn",
                )

        monkeypatch.setattr(
            "arforge.models.provider_adapters.record_token_usage",
            lambda **_kwargs: None,
        )
        adapter = AnthropicAdapter(api_key="test-key", model="external-compatible-model")
        adapter.client = SimpleNamespace(messages=FakeMessages())

        result = adapter.generate_with_tools(
            [{"role": "user", "content": "summarize the partial result"}],
            tools=None,
            max_tokens=32,
        )

        assert result.content == "final answer"
        assert result.usage == {
            "prompt_tokens": 4,
            "completion_tokens": 2,
            "total_tokens": 6,
        }
        assert calls == [{
            "model": "external-compatible-model",
            "max_tokens": 32,
            "messages": [{"role": "user", "content": "summarize the partial result"}],
        }]

    def test_preserves_signed_thinking_blocks_across_tool_turns(self, monkeypatch):
        from arforge.models.provider_adapters import AnthropicAdapter, _to_anthropic_messages

        class Block(SimpleNamespace):
            def model_dump(self, exclude_none=True):
                return {key: value for key, value in vars(self).items() if value is not None}

        class FakeMessages:
            def create(self, **_kwargs):
                return SimpleNamespace(
                    content=[
                        Block(type="thinking", thinking="inspect", signature="signed-1"),
                        Block(type="tool_use", id="call-1", name="read_file", input={"path": "README.md"}),
                    ],
                    usage=SimpleNamespace(input_tokens=5, output_tokens=3),
                    stop_reason="tool_use",
                )

        monkeypatch.setattr(
            "arforge.models.provider_adapters.record_token_usage",
            lambda **_kwargs: None,
        )
        adapter = AnthropicAdapter(api_key="test-key", model="external-compatible-model")
        adapter.client = SimpleNamespace(messages=FakeMessages())

        response = adapter.generate_with_tools(
            [{"role": "user", "content": "read it"}],
            tools=[{
                "type": "function",
                "function": {
                    "name": "read_file",
                    "parameters": {"type": "object", "properties": {}},
                },
            }],
        )
        _, converted = _to_anthropic_messages([
            {"role": "user", "content": "read it"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path":"README.md"}'},
                }],
                "provider_content": response.provider_content,
            },
            {"role": "tool", "tool_call_id": "call-1", "content": "# title"},
        ])

        assert response.provider_content == [
            {"type": "thinking", "thinking": "inspect", "signature": "signed-1"},
            {"type": "tool_use", "id": "call-1", "name": "read_file", "input": {"path": "README.md"}},
        ]
        assert response.usage == {
            "prompt_tokens": 5,
            "completion_tokens": 3,
            "total_tokens": 8,
        }
        assert converted[1]["content"][0]["signature"] == "signed-1"


class TestConfigMultiProvider:
    """Config keys for multi-provider support."""

    def test_provider_config_key_exists(self):
        import config
        assert hasattr(config, "ARFORGE_PROVIDER")
        assert config.ARFORGE_PROVIDER in {"deepseek", "openai", "anthropic"}

    def test_openai_config_keys(self):
        import config
        assert hasattr(config, "OPENAI_API_KEY")
        assert hasattr(config, "OPENAI_BASE_URL")
        assert hasattr(config, "OPENAI_MODEL")

    def test_anthropic_config_keys(self):
        import config
        assert hasattr(config, "ANTHROPIC_API_KEY")
        assert hasattr(config, "ANTHROPIC_BASE_URL")
        assert hasattr(config, "ANTHROPIC_MODEL")

    def test_context_windows_include_all_providers(self):
        import config
        windows = config.MODEL_CONTEXT_WINDOW
        # DeepSeek models
        assert "deepseek-chat" in windows
        # OpenAI models
        assert "gpt-4o" in windows
        # Anthropic models
        assert "external-compatible-model" in windows


@pytest.mark.parametrize(
    "adapter_class, model",
    [
        ("DeepSeekAdapter", "deepseek-chat"),
        ("OpenAIAdapter", "gpt-4o-mini"),
        ("AnthropicAdapter", "external-compatible-model"),
    ],
)
def test_direct_adapters_apply_the_endpoint_policy(adapter_class, model):
    from arforge.models.deepseek_adapter import DeepSeekAdapter
    from arforge.models.provider_adapters import AnthropicAdapter, OpenAIAdapter
    from arforge.product.model_config_runtime import ModelConfigError

    adapters = {
        "DeepSeekAdapter": DeepSeekAdapter,
        "OpenAIAdapter": OpenAIAdapter,
        "AnthropicAdapter": AnthropicAdapter,
    }

    with pytest.raises(ModelConfigError, match="private model endpoint"):
        adapters[adapter_class](
            api_key="test-key",
            base_url="https://169.254.169.254/latest",
            model=model,
        )
