"""Tests for T32: MCP M3 — Resource/Prompt + Sampling Bridge + ExternalMCPBridge."""

from __future__ import annotations



from arforge.mcp_ecosystem import (
    MCPResource,
    MCPPrompt,
    ResourceRegistry,
    PromptRegistry,
    SamplingBridge,
    SamplingRequest,
    ExternalMCPBridge,
)


class TestResourceRegistry:
    def test_register_and_list(self):
        reg = ResourceRegistry()
        reg.register(MCPResource("file:///doc", "doc", "A document"))
        resources = reg.list_resources()
        assert len(resources) == 1
        assert resources[0]["uri"] == "file:///doc"

    def test_read_resource(self):
        reg = ResourceRegistry()
        reg.register(MCPResource("file:///doc", "doc", "A document"),
                     reader=lambda u: "Hello, World!")
        result = reg.read_resource("file:///doc")
        assert "contents" in result
        assert result["contents"][0]["text"] == "Hello, World!"

    def test_add_file_resource(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("print('hello')", encoding="utf-8")

        reg = ResourceRegistry()
        reg.add_file_resource("arforge://src", f)
        resources = reg.list_resources()
        assert len(resources) == 1
        result = reg.read_resource(resources[0]["uri"])
        assert "print('hello')" in result["contents"][0]["text"]

    def test_read_unknown_resource(self):
        reg = ResourceRegistry()
        result = reg.read_resource("file:///nonexistent")
        assert result.get("isError") is True


class TestPromptRegistry:
    def test_register_and_list(self):
        reg = PromptRegistry()
        reg.register(MCPPrompt(
            "review", "Code review prompt",
            "Review this code:\n{{code}}",
            [{"name": "code", "description": "Code to review", "required": True}],
        ))
        prompts = reg.list_prompts()
        assert len(prompts) == 1
        assert prompts[0]["name"] == "review"

    def test_render_prompt(self):
        reg = PromptRegistry()
        reg.register(MCPPrompt("greet", "Greeting", "Hello, {{name}}!"))
        result = reg.get_prompt("greet", {"name": "World"})
        assert result["messages"][0]["content"]["text"] == "Hello, World!"

    def test_get_unknown_prompt(self):
        reg = PromptRegistry()
        result = reg.get_prompt("nonexistent")
        assert result.get("isError") is True


class TestSamplingBridge:
    def test_create_bridge(self):
        bridge = SamplingBridge(api_key="test-key", model="deepseek-v4-flash")
        assert bridge.model == "deepseek-v4-flash"
        assert bridge.api_key == "test-key"

    def test_request_dataclass(self):
        req = SamplingRequest(
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        )
        assert req.max_tokens == 100
        assert len(req.messages) == 1

    def test_rejects_unsafe_sampling_endpoint_before_creating_client(self):
        import pytest

        from arforge.product.model_config_runtime import ModelConfigError

        bridge = SamplingBridge(
            api_key="test-key",
            base_url="https://169.254.169.254/latest",
        )

        with pytest.raises(ModelConfigError, match="private model endpoint"):
            bridge._ensure_client()

    def test_uses_the_encrypted_runtime_credential_and_endpoint(self, monkeypatch, tmp_path):
        import sys
        from types import SimpleNamespace

        from arforge.product.model_config_runtime import ModelConfigRuntime

        runtime = ModelConfigRuntime(data_dir=tmp_path)
        runtime.set_api_key("deepseek", "stored-sampling-key")
        runtime.set_base_url("deepseek", "https://sampling.example.com/v1")
        captured = {}

        class FakeOpenAI:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
        monkeypatch.delenv("DEEPSEEK_BASE_URL", raising=False)
        monkeypatch.setattr(
            "arforge.product.model_config_runtime.get_model_config",
            lambda: runtime,
        )
        monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))

        SamplingBridge()._ensure_client()

        assert captured == {
            "api_key": "stored-sampling-key",
            "base_url": "https://sampling.example.com/v1",
        }


class TestExternalMCPBridge:
    def test_create_bridge(self):
        bridge = ExternalMCPBridge()
        assert bridge.list_servers() == []

    def test_connect_stdio_to_test_server(self):
        """Connect to the built-in MCP test server and call a tool."""
        import sys

        bridge = ExternalMCPBridge()
        try:
            result = bridge.connect_stdio("test-server", [
                sys.executable, "-m", "arforge.mcp_test_server",
            ])
            assert result["tools"] > 0
            servers = bridge.list_servers()
            assert len(servers) == 1

            # Call a tool
            tool_result = bridge.call_tool("test-server", "echo", {"text": "hello"})
            assert "hello" in str(tool_result)

        finally:
            bridge.disconnect_all()
